// Pure functions that turn raw Toast orders / time entries for one location
// and one business date into the aggregate rows stored in D1.
//
// Definitions (reconcile against Toast's Sales Summary report when onboarding):
//   gross sales = pre-discount price of every non-voided item
//   discounts   = item-level + check-level discounts and comps
//   net sales   = gross sales - discounts
//   Gift card sales/reloads and house-account payments are excluded (deferred
//   revenue), matching Toast's net sales. Tax, tips and service charges are
//   tracked separately and are not part of net sales.

import { hourIn, localParts, weekdayIn } from './dates.js';

const DEFERRED_SELECTION_TYPES = new Set([
  'TOAST_CARD_SELL',
  'TOAST_CARD_RELOAD',
  'HOUSE_ACCOUNT_PAY_BALANCE',
  'CASH_CARD_SELL',
]);
const VOIDED_PAYMENT_STATUSES = new Set(['VOIDED', 'DENIED', 'CANCELLED']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const round2 = (v) => Math.round(v * 100) / 100;
const sum = (arr, f) => (arr ?? []).reduce((acc, x) => acc + num(f(x)), 0);

function bump(map, key, init) {
  let row = map.get(key);
  if (!row) {
    row = init();
    map.set(key, row);
  }
  return row;
}

function selectionGross(sel) {
  if (sel.preDiscountPrice !== undefined && sel.preDiscountPrice !== null) return num(sel.preDiscountPrice);
  return num(sel.price) + sum(sel.appliedDiscounts, (d) => d.discountAmount);
}

/**
 * @param {object[]} orders  Toast Order objects for a single business date
 * @param {object}   ctx     { timezone, lookups: { diningOptions, revenueCenters, salesCategories, employees } }
 */
const parseTime = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/**
 * Whole-ticket kitchen time in minutes: earliest item fired (createdDate) to
 * latest item marked READY (its modifiedDate is the KDS bump). Voided and
 * deleted items (and voided checks) are ignored. null when no item on the ticket was bumped to READY, or the
 * span is outside 0-240 minutes. Items only reach READY where the kitchen
 * bumps tickets on the Toast KDS.
 */
export function ticketReadyMinutes(checks) {
  let fired = null;
  let ready = null;
  for (const check of checks ?? []) {
    if (!check || check.deleted || check.voided) continue;
    for (const sel of check.selections ?? []) {
      if (!sel || sel.voided || sel.deleted) continue;
      const created = parseTime(sel.createdDate);
      if (created !== null && (fired === null || created < fired)) fired = created;
      if (sel.fulfillmentStatus === 'READY') {
        const modified = parseTime(sel.modifiedDate);
        if (modified !== null && (ready === null || modified > ready)) ready = modified;
      }
    }
  }
  if (fired === null || ready === null) return null;
  const mins = (ready - fired) / 60000;
  return mins >= 0 && mins < 240 ? Math.round(mins * 100) / 100 : null;
}

export function aggregateOrders(orders, ctx) {
  const tz = ctx.timezone || 'America/New_York';
  const lk = ctx.lookups || {};
  const nameOf = (map, ref, fallback) => (ref?.guid && map?.get(ref.guid)) || fallback;

  // Toast leaves the revenue center empty on some orders, e.g. DoorDash orders
  // sent in by the integration before it was given a revenue center. Those go
  // to the revenue center that starts their dining option's name
  // ("DoorDash - Delivery" -> "DoorDash"), longest match first.
  const centers = [...new Set(lk.revenueCenters?.values() ?? [])]
    .map((name) => ({ name, key: squash(name) }))
    .filter((c) => c.key)
    .sort((a, b) => b.key.length - a.key.length);
  const revenueCenterOf = (order, diningOption) => {
    const named = nameOf(lk.revenueCenters, order.revenueCenter, null);
    if (named) return named;
    const key = squash(diningOption ?? '');
    return centers.find((c) => key.startsWith(c.key))?.name || 'Unspecified';
  };

  const daily = {
    orders: 0,
    checks: 0,
    guests: 0,
    gross_sales: 0,
    discounts: 0,
    net_sales: 0,
    voids: 0,
    void_count: 0,
    service_charges: 0,
    tax: 0,
    tips: 0,
  };
  const hourly = new Map();
  const tickets = [];
  const mix = new Map();
  const items = new Map();
  const discounts = new Map();

  const addMix = (dimension, label, vals) => {
    const row = bump(mix, `${dimension}\u0000${label}`, () => ({
      dimension,
      label,
      orders: 0,
      quantity: 0,
      gross_sales: 0,
      discounts: 0,
      net_sales: 0,
    }));
    for (const [k, v] of Object.entries(vals)) row[k] += v;
  };

  const addDiscount = (d) => {
    const name = d.name || d.discount?.name || 'Unnamed discount';
    const approver = nameOf(lk.employees, d.approver, '') || '';
    const row = bump(discounts, `${name}\u0000${approver}`, () => ({
      discount_name: name,
      approver,
      uses: 0,
      amount: 0,
    }));
    row.uses += 1;
    row.amount += num(d.discountAmount);
  };

  for (const order of orders ?? []) {
    if (!order || order.deleted) continue;
    const orderVoided = !!order.voided;

    let orderGross = 0;
    let orderDisc = 0;
    let orderCounted = false;
    const categoriesInOrder = new Set();

    for (const check of order.checks ?? []) {
      if (!check || check.deleted) continue;
      const checkVoided = orderVoided || !!check.voided;

      // Pass 1: item-level totals for this check.
      const live = [];
      for (const sel of check.selections ?? []) {
        if (!sel || sel.deleted) continue;
        if (DEFERRED_SELECTION_TYPES.has(sel.selectionType)) continue;
        if (checkVoided || sel.voided) {
          daily.voids += selectionGross(sel);
          daily.void_count += num(sel.quantity) || 1;
          continue;
        }
        const gross = selectionGross(sel);
        const itemDisc = sum(sel.appliedDiscounts, (d) => d.discountAmount);
        live.push({ sel, gross, itemDisc });
      }
      if (checkVoided) continue;

      daily.checks += 1;
      orderCounted = true;

      const checkLevelDisc = sum(check.appliedDiscounts, (d) => d.discountAmount);
      const itemsNet = live.reduce((a, x) => a + (x.gross - x.itemDisc), 0);
      // Share of each item's value eaten by check-level discounts.
      const checkRatio = itemsNet > 0 ? Math.min(1, checkLevelDisc / itemsNet) : 0;

      for (const { sel, gross, itemDisc } of live) {
        const allocatedCheckDisc = (gross - itemDisc) * checkRatio;
        const disc = itemDisc + allocatedCheckDisc;
        const net = gross - disc;
        const qty = num(sel.quantity) || 1;
        const category = nameOf(lk.salesCategories, sel.salesCategory, 'Uncategorized');
        const itemName = sel.displayName || sel.item?.name || 'Unknown item';

        orderGross += gross;
        orderDisc += disc;

        const item = bump(items, `${itemName}\u0000${category}`, () => ({
          item_name: itemName,
          sales_category: category,
          quantity: 0,
          gross_sales: 0,
          net_sales: 0,
        }));
        item.quantity += qty;
        item.gross_sales += gross;
        item.net_sales += net;

        addMix('sales_category', category, {
          orders: categoriesInOrder.has(category) ? 0 : 1,
          quantity: qty,
          gross_sales: gross,
          discounts: disc,
          net_sales: net,
        });
        categoriesInOrder.add(category);

        for (const d of sel.appliedDiscounts ?? []) addDiscount(d);
      }
      for (const d of check.appliedDiscounts ?? []) addDiscount(d);

      daily.tax += num(check.taxAmount);
      daily.service_charges += sum(check.appliedServiceCharges, (s) => s.chargeAmount);
      daily.tips += sum(
        (check.payments ?? []).filter((p) => !VOIDED_PAYMENT_STATUSES.has(p?.paymentStatus)),
        (p) => p.tipAmount,
      );
    }

    if (!orderCounted) continue;

    const orderNet = orderGross - orderDisc;
    const guests = num(order.numberOfGuests);
    daily.orders += 1;
    daily.guests += guests;
    daily.gross_sales += orderGross;
    daily.discounts += orderDisc;
    daily.net_sales += orderNet;

    const opened = order.openedDate || order.createdDate;
    const hour = hourIn(opened, tz);
    const ticketMinutes = ticketReadyMinutes(order.checks);
    const weekday = weekdayIn(opened, tz);
    if (ticketMinutes !== null && hour !== null && weekday !== null) {
      tickets.push({ order_guid: order.guid || `order-${tickets.length}`, weekday, hour, minutes: ticketMinutes });
    }
    if (hour !== null) {
      const h = bump(hourly, hour, () => ({ hour, orders: 0, guests: 0, net_sales: 0 }));
      h.orders += 1;
      h.guests += guests;
      h.net_sales += orderNet;
    }

    const orderVals = { orders: 1, quantity: 0, gross_sales: orderGross, discounts: orderDisc, net_sales: orderNet };
    const diningOption = nameOf(lk.diningOptions, order.diningOption, null);
    addMix('dining_option', diningOption || 'Unspecified', orderVals);
    addMix('revenue_center', revenueCenterOf(order, diningOption), orderVals);
  }

  return {
    daily: roundAll(daily),
    hourly: [...hourly.values()].map(roundAll).sort((a, b) => a.hour - b.hour),
    mix: [...mix.values()].map(roundAll),
    items: [...items.values()].map(roundAll),
    discounts: [...discounts.values()].map(roundAll).filter((d) => d.amount !== 0 || d.uses > 0),
    // One row per order with a KDS ticket time (opened in local weekday/hour).
    tickets,
  };
}

/**
 * @param {object[]} entries  Toast TimeEntry objects for one business date
 * @param {object}   ctx      { lookups: { jobs }, overtimeMultiplier, salariedLaborPerDay }
 */
export function aggregateLabor(entries, ctx = {}) {
  const otMult = ctx.overtimeMultiplier ?? 1.5;
  const jobs = ctx.lookups?.jobs;
  const byJob = new Map();

  for (const e of entries ?? []) {
    if (!e || e.deleted) continue;
    const title = (e.jobReference?.guid && jobs?.get(e.jobReference.guid)) || 'Unassigned';
    const row = bump(byJob, title, () => ({
      job_title: title,
      employeeSet: new Set(),
      shifts: 0,
      regular_hours: 0,
      overtime_hours: 0,
      regular_cost: 0,
      overtime_cost: 0,
    }));
    const wage = num(e.hourlyWage);
    const reg = num(e.regularHours);
    const ot = num(e.overtimeHours);
    if (e.employeeReference?.guid) row.employeeSet.add(e.employeeReference.guid);
    row.shifts += 1;
    row.regular_hours += reg;
    row.overtime_hours += ot;
    row.regular_cost += reg * wage;
    row.overtime_cost += ot * wage * otMult;
  }

  const rows = [...byJob.values()].map(({ employeeSet, ...r }) => roundAll({ ...r, employees: employeeSet.size }));

  if (num(ctx.salariedLaborPerDay) > 0) {
    rows.push({
      job_title: 'Salaried',
      employees: 0,
      shifts: 0,
      regular_hours: 0,
      overtime_hours: 0,
      regular_cost: round2(num(ctx.salariedLaborPerDay)),
      overtime_cost: 0,
    });
  }
  return rows;
}

function roundAll(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'number' ? round2(v) : v;
  return out;
}

/**
 * Adds a shift's hours (ms timestamps) to local clock-hour buckets by the
 * fraction worked: 4:30-6:15pm adds 0.5 to 4pm, 1.0 to 5pm and 0.25 to 6pm.
 * acc: Map("<local date>|<hour>" -> hours).
 */
export function accumulateHours(acc, startMs, endMs, timeZone) {
  let cur = startMs;
  while (cur < endMs) {
    const p = localParts(cur, timeZone);
    const next = cur - ((p.minute * 60 + p.second) * 1000 + (cur % 1000)) + 3600000; // next local hour
    const segEnd = Math.min(next, endMs);
    if (segEnd <= cur) break;
    const key = `${p.date}|${p.hour}`;
    acc.set(key, (acc.get(key) || 0) + (segEnd - cur) / 3600000);
    cur = segEnd;
  }
  return acc;
}

/**
 * Hours on the clock per local date, hour and job title (Kitchen tab
 * staffing): [{ local_date, hour, job_title, hours }]. Deleted entries and
 * shifts without a clock-out yet are skipped.
 */
export function laborHoursByHour(entries, ctx = {}) {
  const tz = ctx.timezone || 'America/New_York';
  const jobs = ctx.lookups?.jobs;
  const byJob = new Map();
  for (const e of entries ?? []) {
    if (!e || e.deleted) continue;
    const start = parseTime(e.inDate);
    const end = parseTime(e.outDate);
    if (start === null || end === null || end <= start) continue;
    const title = (e.jobReference?.guid && jobs?.get(e.jobReference.guid)) || 'Unassigned';
    if (!byJob.has(title)) byJob.set(title, new Map());
    accumulateHours(byJob.get(title), start, end, tz);
  }
  const rows = [];
  for (const [title, acc] of byJob) {
    for (const [key, hours] of acc) {
      const [date, hour] = key.split('|');
      rows.push({ local_date: date, hour: Number(hour), job_title: title, hours: Math.round(hours * 10000) / 10000 });
    }
  }
  return rows.sort((a, b) => a.local_date.localeCompare(b.local_date) || a.hour - b.hour || a.job_title.localeCompare(b.job_title));
}

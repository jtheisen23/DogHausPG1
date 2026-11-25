#!/usr/bin/env node
// Toast connection check: signs in, then for each configured location reads
// the restaurant record, lookup tables, and one day of orders and time entries.
// Nothing is written anywhere and no Cloudflare settings are needed.
//
//   node etl/src/check.js [--date YYYY-MM-DD]      (default: yesterday)
//
// Environment: TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, [TOAST_API_HOST], LOCATIONS_JSON
// In GitHub Actions a Markdown report is also written to the job summary.

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { addDays, parseDate, todayIn, toToastDate } from './dates.js';
import { loadLocations } from './config.js';
import { ToastClient } from './toast.js';
import { aggregateLabor, aggregateOrders, laborHoursByHour } from './transform.js';
import { kitchenTitles } from '../../worker/src/kitchen.js';

const { values: args } = parseArgs({
  options: {
    date: { type: 'string' },
    config: { type: 'string', default: 'config/locations.json' },
  },
});

const lines = [];
const out = (s = '') => {
  console.log(s);
  lines.push(s);
};

// Which Toast permission each endpoint needs, so failures say what to enable.
const LOOKUPS = [
  ['/config/v2/diningOptions', 'Configuration', 'dining option names'],
  ['/config/v2/revenueCenters', 'Configuration', 'revenue center names'],
  ['/config/v2/salesCategories', 'Configuration', 'sales category names'],
  ['/labor/v1/jobs', 'Labor', 'job titles'],
  ['/labor/v1/employees', 'Labor (employees)', 'manager names on comps'],
];

function reason(err) {
  const m = /failed: (\d{3})/.exec(err.message);
  const status = m ? Number(m[1]) : null;
  if (status === 401 || status === 403) return `HTTP ${status}: not allowed; the credential is probably missing this permission or location`;
  if (status === 404) return 'HTTP 404: not found';
  return err.message.slice(0, 200);
}

// Orders whose revenue center Toast doesn't name (none on the order, or one
// missing from the lookup), by order source and dining option, with where the
// dashboard files them, so they can be matched to Toast's reports.
function ordersWithoutRevenueCenter(orders, ctx) {
  const { revenueCenters, diningOptions } = ctx.lookups;
  const groups = new Map();
  for (const order of orders) {
    const guid = order.revenueCenter?.guid;
    if (guid && revenueCenters.has(guid)) continue;
    const { daily, mix } = aggregateOrders([order], ctx);
    if (!daily.orders) continue;
    const key = [
      guid ? `revenue center ${guid} not in lookup` : 'no revenue center',
      `source "${order.source || 'none'}"`,
      `dining option "${(order.diningOption?.guid && diningOptions.get(order.diningOption.guid)) || 'none'}"`,
    ].join(', ') + ` → ${mix.find((m) => m.dimension === 'revenue_center')?.label}`;
    const g = groups.get(key) ?? { orders: 0, net: 0 };
    g.orders += 1;
    g.net += daily.net_sales;
    groups.set(key, g);
  }
  if (!groups.size) return [];
  return [
    'Orders with no revenue center in Toast (→ where the dashboard files them):',
    ...[...groups].sort((a, b) => b[1].net - a[1].net).map(([k, g]) => `  - ${k}: ${g.orders} orders, $${g.net.toFixed(2)}`),
  ];
}

/**
 * Probes the Kitchen API (KDS ticket times) for one day. Read-only and
 * informational: it reports what comes back so the data can be mapped before
 * the sync stores any of it. Names of people are masked; the log may be public.
 */
/**
 * Ticket times (Kitchen tab): how many orders had an item bumped to READY on
 * the KDS, and the item fulfillment statuses seen. 0 timed orders means the
 * kitchen doesn't bump on the KDS and the Kitchen card stays hidden.
 */
function ticketTimeLine(orders, sales) {
  const statuses = new Map();
  for (const o of orders) {
    if (!o || o.deleted || o.voided) continue;
    for (const c of o.checks ?? []) {
      if (!c || c.deleted || c.voided) continue;
      for (const s of c.selections ?? []) {
        if (!s || s.voided || s.deleted) continue;
        const k = s.fulfillmentStatus || 'none';
        statuses.set(k, (statuses.get(k) || 0) + 1);
      }
    }
  }
  const mins = sales.tickets.map((t) => t.minutes).sort((a, b) => a - b);
  const median = mins.length ? (mins.length % 2 ? mins[(mins.length - 1) / 2] : (mins[mins.length / 2 - 1] + mins[mins.length / 2]) / 2) : null;
  const seen = [...statuses].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'no items';
  return mins.length
    ? `Ticket times: ${mins.length} of ${sales.daily.orders} orders have an item bumped to READY (median ${median.toFixed(1)} min). Item statuses: ${seen}.`
    : `⚠️ Ticket times: 0 of ${sales.daily.orders} orders have an item bumped to READY, so the Kitchen card stays hidden for this location. Item statuses: ${seen}.`;
}

/**
 * Kitchen tab staffing chart: job titles on the clock, the hours that count as
 * kitchen staff (KITCHEN_JOB_TITLES, default Kitchen and Expo) and how many of the
 * day's hours have >= 3 orders, >= 0.25 kitchen hours and a timed ticket (the
 * chart needs 6 such hours over its 8 weeks).
 */
function staffingLines(entries, sales, date, ctx) {
  const kitchen = kitchenTitles(process.env);
  const rows = laborHoursByHour(entries, ctx);
  const byTitle = new Map();
  for (const r of rows) byTitle.set(r.job_title, (byTitle.get(r.job_title) || 0) + r.hours);
  const isKitchen = (t) => kitchen.has(t.trim().toLowerCase());
  const titles = [...byTitle].sort((a, b) => b[1] - a[1]).map(([t, hrs]) => `${t} ${hrs.toFixed(1)}h${isKitchen(t) ? ' (kitchen)' : ''}`);
  // Orders and tickets are by business date; hours after midnight fall on the next calendar day.
  const dayOf = (hour) => (hour < 4 ? addDays(date, 1) : date);
  const kitchenAt = new Map();
  for (const r of rows) if (isKitchen(r.job_title)) kitchenAt.set(`${r.local_date}|${r.hour}`, (kitchenAt.get(`${r.local_date}|${r.hour}`) || 0) + r.hours);
  const timedAt = new Map();
  for (const t of sales?.tickets ?? []) timedAt.set(t.hour, (timedAt.get(t.hour) || 0) + 1);
  const units = (sales?.hourly ?? []).filter((h) => h.orders >= 3 && (kitchenAt.get(`${dayOf(h.hour)}|${h.hour}`) || 0) >= 0.25 && timedAt.get(h.hour)).length;
  const kitchenHours = [...kitchenAt.values()].reduce((a, b) => a + b, 0);
  return [
    `Job titles on the clock: ${titles.join(', ') || 'none'}`,
    `Staffing chart: ${kitchenHours.toFixed(1)} kitchen staff hours (${[...kitchen].join(', ')}), ${sales?.tickets?.length ?? 0} timed tickets, ${units} hours with 3+ orders, a cook on the clock and a timed ticket (the chart needs 6 over its 8 weeks).`,
  ];
}

async function kitchenProbe(toast, guid, date) {
  const path = '/kitchen/v1/export/itemFulfillments';
  // Raw requests, so an empty or non-JSON reply is reported as it is.
  if (!toast.token || Date.now() >= toast.tokenExpiresAt) await toast.authenticate();
  const lines = [];
  // Prep stations exist only where Toast KDS is set up (standard API access).
  {
    const res = await fetch(new URL(toast.host + '/kitchen/v1/published/prepStations'), {
      headers: { Authorization: `Bearer ${toast.token}`, 'Toast-Restaurant-External-ID': guid, Accept: 'application/json' },
    });
    const text = await res.text();
    let stations = null;
    try { stations = JSON.parse(text); } catch { /* reported below */ }
    const list = Array.isArray(stations) ? stations : Array.isArray(stations?.data) ? stations.data : null;
    lines.push(list
      ? `   KDS prep stations: HTTP ${res.status}, ${list.length} found${list.length ? ` (${list.map((x) => x?.name || x?.guid).filter(Boolean).slice(0, 12).join(', ')})` : ''}`
      : `   KDS prep stations: HTTP ${res.status}, ${text.length} bytes${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ' (empty body)'}`);
  }
  let body = null;
  let used = null;
  for (const d of [toToastDate(date), toToastDate(addDays(date, -1))]) {
    const url = new URL(toast.host + path);
    url.searchParams.set('businessDate', d);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${toast.token}`, 'Toast-Restaurant-External-ID': guid, Accept: 'application/json' },
    });
    const text = await res.text();
    const type = res.headers.get('content-type') || 'none';
    lines.push(`   Kitchen request businessDate=${d}: HTTP ${res.status}, content-type ${type}, ${text.length} bytes${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 300)}` : ' (empty body)'}`);
    if (res.ok && text) {
      try { body = JSON.parse(text); used = d; break; } catch { /* not JSON; reported above */ }
    }
  }
  if (!body) {
    lines.unshift('⚠️ **Kitchen (KDS)**: no kitchen data came back (details below).');
    return lines;
  }
  const records = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  lines.unshift(`✅ **Kitchen (KDS)** for ${date}: ${records.length} item fulfillments read (businessDate=${used}; response: ${Array.isArray(body) ? 'array' : `{${Object.keys(body || {}).join(', ')}}`}).`);
  if (!records.length) {
    lines.push("   No records. That's expected if the store doesn't use Toast KDS screens or was closed.");
    return lines;
  }
  const keys = [...new Set(records.flatMap((r) => Object.keys(r || {})))];
  lines.push(`   Fields: ${keys.join(', ')}`);
  const isTime = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
  const timeKeys = keys.filter((k) => records.some((r) => isTime(r?.[k])));
  lines.push(`   Timestamp fields: ${timeKeys.join(', ') || 'none at the top level'}`);
  const fired = timeKeys.find((k) => /fire|sent/i.test(k));
  const done = timeKeys.find((k) => k !== fired && /fulfil|complete|done|bump|ready/i.test(k));
  if (fired && done) {
    const mins = records
      .map((r) => (Date.parse(r[done]) - Date.parse(r[fired])) / 60000)
      .filter((m) => Number.isFinite(m) && m >= 0)
      .sort((a, b) => a - b);
    const at = (q) => mins[Math.min(mins.length - 1, Math.floor(q * mins.length))];
    if (mins.length) {
      lines.push(`   ${fired} → ${done}: ${mins.length} items timed; median ${at(0.5).toFixed(1)} min, 90th percentile ${at(0.9).toFixed(1)} min, longest ${mins[mins.length - 1].toFixed(1)} min, over 10 min: ${mins.filter((m) => m > 10).length}.`);
    }
  }
  for (const k of keys.filter((x) => /level|station|status|type/i.test(x))) {
    const counts = new Map();
    for (const r of records) {
      const v = r?.[k];
      const label = v && typeof v === 'object' ? (v.name || v.guid || JSON.stringify(v).slice(0, 40)) : String(v);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    lines.push(`   ${k}: ${[...counts].slice(0, 8).map(([v, n]) => `${v} (${n})`).join(', ')}`);
  }
  const mask = (key, v) => (/employee|server|customer|guest|phone|email|firstname|lastname/i.test(key) && typeof v === 'string' ? '•••' : v);
  const sample = JSON.stringify(records[0], mask);
  lines.push(`   Sample record: ${sample.length > 700 ? `${sample.slice(0, 700)}…` : sample}`);
  return lines;
}

async function main() {
  const locations = loadLocations(args.config);
  const toast = new ToastClient({
    clientId: process.env.TOAST_CLIENT_ID,
    clientSecret: process.env.TOAST_CLIENT_SECRET,
    host: process.env.TOAST_API_HOST || undefined,
    log: () => {}, // keep retries out of the report
  });

  out('# Toast connection check');
  out();
  try {
    await toast.authenticate();
    out('✅ **Sign-in** succeeded with the client ID and secret.');
  } catch (err) {
    out(`❌ **Sign-in failed**: ${err.message.slice(0, 300)}`);
    out();
    out('Check the TOAST_CLIENT_ID and TOAST_CLIENT_SECRET secrets. Nothing else can be tested until sign-in works.');
    return false;
  }
  out();

  let ok = true;
  for (const loc of locations) {
    const tz = loc.timezone || 'America/New_York';
    const date = args.date || addDays(todayIn(tz), -1);
    parseDate(date);
    const guid = loc.toastGuid;
    out(`## ${loc.id}: ${loc.name}`);
    out();
    if (!guid) {
      out('❌ No toastGuid configured for this location.');
      ok = false;
      out();
      continue;
    }

    try {
      const r = await toast.get(`/restaurants/v1/restaurants/${guid}`, guid);
      const name = [r?.general?.name, r?.general?.locationName].filter(Boolean).join(' – ');
      out(`✅ **Restaurant**: Toast calls this location "${name || 'unnamed'}"${r?.general?.timeZone ? `, time zone ${r.general.timeZone}` : ''}.`);
      if (r?.general?.timeZone && r.general.timeZone !== tz) {
        out(`   ⚠️ Toast's time zone differs from the configured "${tz}".`);
      }
    } catch (err) {
      out(`⚠️ **Restaurant details** unavailable (${reason(err)}). This isn't needed for the dashboard.`);
    }

    const lookups = { diningOptions: new Map(), revenueCenters: new Map(), salesCategories: new Map(), jobs: new Map(), employees: new Map() };
    const keyFor = { '/config/v2/diningOptions': 'diningOptions', '/config/v2/revenueCenters': 'revenueCenters', '/config/v2/salesCategories': 'salesCategories', '/labor/v1/jobs': 'jobs', '/labor/v1/employees': 'employees' };
    for (const [path, perm, what] of LOOKUPS) {
      try {
        const rows = await toast.get(path, guid);
        const list = Array.isArray(rows) ? rows : [];
        for (const x of list) {
          if (!x?.guid) continue;
          const label = path.endsWith('jobs') ? x.title : path.endsWith('employees')
            ? [x.chosenName || x.firstName, x.lastName].filter(Boolean).join(' ')
            : x.name;
          lookups[keyFor[path]].set(x.guid, label);
        }
        const names = path.endsWith('revenueCenters') || path.endsWith('diningOptions')
          ? ` (${list.map((x) => x?.name).filter(Boolean).join(', ')})`
          : '';
        out(`✅ ${what}: ${list.length} found${names}`);
      } catch (err) {
        out(`⚠️ ${what}: ${reason(err)}. Enable **${perm}** read access, or these will show as "Unspecified".`);
      }
    }

    let sales = null;
    try {
      const orders = await toast.ordersForBusinessDate(guid, toToastDate(date));
      sales = aggregateOrders(orders, { timezone: tz, lookups });
      const d = sales.daily;
      out(`✅ **Orders** for ${date}: ${orders.length} orders read. Net sales $${d.net_sales.toFixed(2)}, gross $${d.gross_sales.toFixed(2)}, discounts $${d.discounts.toFixed(2)}, ${d.guests} guests, tax $${d.tax.toFixed(2)}, tips $${d.tips.toFixed(2)}.`);
      const cats = sales.mix.filter((m) => m.dimension === 'sales_category').map((m) => `${m.label} $${m.net_sales.toFixed(0)}`);
      if (cats.length) out(`   Sales categories: ${cats.join(', ')}`);
      const dos = sales.mix.filter((m) => m.dimension === 'dining_option').map((m) => `${m.label} (${m.orders})`);
      if (dos.length) out(`   Dining options: ${dos.join(', ')}`);
      const rcs = sales.mix.filter((m) => m.dimension === 'revenue_center').map((m) => `${m.label} $${m.net_sales.toFixed(0)} (${m.orders})`);
      if (rcs.length) out(`   Revenue centers: ${rcs.join(', ')}`);
      for (const line of ordersWithoutRevenueCenter(orders, { timezone: tz, lookups })) out(`   ${line}`);
      out(`   ${ticketTimeLine(orders, sales)}`);
      if (!orders.length) out("   ⚠️ No orders that day. That's expected if the location was closed; otherwise check the GUID.");
    } catch (err) {
      ok = false;
      out(`❌ **Orders**: ${reason(err)}. Enable **Orders** read access for this location. The dashboard can't work without it.`);
    }

    try {
      const entries = await toast.timeEntriesForBusinessDate(guid, toToastDate(date));
      const labor = aggregateLabor(entries, { lookups, salariedLaborPerDay: loc.salariedLaborPerDay });
      const cost = labor.reduce((a, r) => a + r.regular_cost + r.overtime_cost, 0);
      const hours = labor.reduce((a, r) => a + r.regular_hours + r.overtime_hours, 0);
      out(`✅ **Labor** for ${date}: ${entries.length} time entries, ${hours.toFixed(1)} hours, $${cost.toFixed(2)} labor cost.`);
      if (entries.length && cost === 0) out('   ⚠️ Hours were found but cost is $0. Wages may not be entered in Toast, so labor % will be empty.');
      if (sales?.daily.net_sales > 0 && cost > 0) out(`   Labor % that day: ${((cost / sales.daily.net_sales) * 100).toFixed(1)}%`);
      for (const line of staffingLines(entries, sales, date, { timezone: tz, lookups })) out(`   ${line}`);
    } catch (err) {
      out(`⚠️ **Labor**: ${reason(err)}. Enable **Labor** read access to see labor in the dashboard.`);
    }

    try {
      for (const line of await kitchenProbe(toast, guid, date)) out(line);
    } catch (err) {
      out(`⚠️ **Kitchen (KDS)**: ${reason(err)}`);
    }
    out();
  }

  out(ok
    ? '**Result:** Toast is ready. Compare the net sales above against Toast\'s Sales Summary report for the same day.'
    : '**Result:** some required checks failed; see ❌ above.');
  return ok;
}

main()
  .then((ok) => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error(err.message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `❌ ${err.message}\n`);
    process.exit(1);
  });

// Kitchen tab heatmaps (weekday x hour, local time, last 8 complete weeks):
//  - ticket times: from ticket_times (one row per order whose kitchen bumped it
//    to READY on the Toast KDS);
//  - average orders: from hourly_sales (orders per business date and hour).

/**
 * Python's round(x, digits), exactly: it rounds the double's true decimal
 * value, and only true ties go to the even neighbour (round(0.15, 1) is 0.1
 * because 0.15 is stored as 0.1499...; round(1.25, 1) is 1.2).
 */
export function roundHalfEven(x, digits = 0) {
  if (!Number.isFinite(x)) return x;
  // toFixed works on the exact value of the double; 80 places hold all of it
  // for the magnitudes used here (minutes, order counts, percentages).
  const [int, frac] = Math.abs(x).toFixed(80).split('.');
  let n = BigInt(int + frac.slice(0, digits));
  const rest = frac.slice(digits);
  const above = /[1-9]/.test(rest.slice(1));
  if (rest[0] > '5' || (rest[0] === '5' && (above || n % 2n === 1n))) n += 1n;
  const s = n.toString().padStart(digits + 1, '0');
  const v = Number(digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s);
  return x < 0 && v !== 0 ? -v : v;
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * rows: [{ weekday (Mon = 0), hour (local), minutes }].
 * Returns { hours: [int], cells: { "<wd>-<hour>": { median, n, over } } }, or
 * null when no cell has at least minN tickets. over = % of tickets over 20 min.
 */
export function buildTicketHeatmap(rows, minN = 3) {
  const grid = new Map();
  for (const r of rows || []) {
    const minutes = Number(r.minutes);
    if (!Number.isFinite(minutes)) continue;
    const key = `${Number(r.weekday)}-${Number(r.hour)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(minutes);
  }
  const cells = {};
  for (const [key, v] of grid) {
    if (v.length < minN) continue;
    cells[key] = {
      median: roundHalfEven(median(v), 1),
      n: v.length,
      over: roundHalfEven((100 * v.filter((x) => x > 20).length) / v.length),
    };
  }
  const keys = Object.keys(cells);
  if (!keys.length) return null;
  const hours = [...new Set(keys.map((k) => Number(k.split('-')[1])))].sort((a, b) => a - b);
  return { hours, cells };
}

const dayFormatters = new Map();
/** Today's date (YYYY-MM-DD) in a time zone. */
export function todayIn(timeZone, now = new Date()) {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timeZone, f);
  }
  return f.format(now);
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The last `weeks` complete Monday-Sunday weeks before the week `today` is in. */
export function completedWeeks(today, weeks = 8) {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const end = addDays(today, -dow - 1); // the Sunday before this week
  return { start: addDays(end, -(weeks * 7 - 1)), end };
}

/** Monday = 0 ... Sunday = 6 for a YYYY-MM-DD date. */
export function weekdayOf(date) {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * hourly_sales is keyed by Toast business date. Orders opened after midnight
 * (before Toast's default 4am closeout) belong to the previous business date,
 * but the heatmap buckets by the calendar date the order was opened on.
 */
export const CLOSEOUT_HOUR = 4;
export function calendarDate(businessDate, hour) {
  return hour < CLOSEOUT_HOUR ? addDays(businessDate, 1) : businessDate;
}

/**
 * Average orders per (local weekday, hour). rows: [{ date (local calendar
 * date), hour, orders }] with voided orders already left out. A weekday's
 * operating dates are its dates with any order; a cell is that weekday-hour's
 * orders / operating dates, kept only when the hour had orders on at least
 * max(2, 40%) of those dates (so closed hours and stray orders stay blank).
 * Returns { hours, cells: { "<wd>-<hour>": avg (1 dp) } } or null.
 */
export function buildOrdersHeatmap(rows, minOpenShare = 0.4) {
  const counts = new Map(); // "date|hour" -> orders
  for (const r of rows || []) {
    const n = Number(r.orders) || 0;
    if (n <= 0) continue;
    const key = `${r.date}|${Number(r.hour)}`;
    counts.set(key, (counts.get(key) || 0) + n);
  }
  if (!counts.size) return null;
  const wdDates = new Map(); // weekday -> Set(dates)
  const total = new Map(); // "wd-hour" -> orders
  const days = new Map(); // "wd-hour" -> dates with orders
  for (const [key, n] of counts) {
    const [date, hour] = key.split('|');
    const wd = weekdayOf(date);
    if (!wdDates.has(wd)) wdDates.set(wd, new Set());
    wdDates.get(wd).add(date);
    const cell = `${wd}-${hour}`;
    total.set(cell, (total.get(cell) || 0) + n);
    days.set(cell, (days.get(cell) || 0) + 1);
  }
  const cells = {};
  for (const [cell, n] of total) {
    const occ = wdDates.get(Number(cell.split('-')[0]))?.size || 0;
    if (!occ || days.get(cell) < Math.max(2, occ * minOpenShare)) continue;
    cells[cell] = roundHalfEven(n / occ, 1);
  }
  const keys = Object.keys(cells);
  if (!keys.length) return null;
  const hours = [...new Set(keys.map((k) => Number(k.split('-')[1])))].sort((a, b) => a - b);
  return { hours, cells };
}

/** One shared color-scale max across the locations shown, so grids compare. */
export function ordersHeatmapPayload(byLoc, present) {
  const locations = present.filter((id) => byLoc[id]);
  if (!locations.length) return null;
  const values = locations.flatMap((id) => Object.values(byLoc[id].cells));
  const max = Math.max(0, ...values) || 1;
  return { locations, byLoc: Object.fromEntries(locations.map((id) => [id, byLoc[id]])), max };
}

// --- Ticket time trend -------------------------------------------------------
// Medians can't be added up across days, so each point is computed in SQL from
// the ticket rows of its bucket. Buckets match the dashboard's (weeks start on
// Monday, months on the 1st; 'hour' is used when a single day is selected).
const TICKET_BUCKETS = {
  hour: 'hour',
  day: 'business_date',
  week: "date(business_date, '-' || ((CAST(strftime('%w', business_date) AS INTEGER) + 6) % 7) || ' days')",
  month: "substr(business_date, 1, 7) || '-01'",
};
export const TICKET_GRAINS = Object.keys(TICKET_BUCKETS);

/**
 * SQL for ticket-time stats per (location, bucket), plus '_all' (every
 * selected location pooled) per bucket: n tickets, `over` = tickets over 20
 * min, and the median minutes. Binds: start, end, then each location id.
 */
export function ticketTrendSql(grain, locationCount) {
  const bucket = TICKET_BUCKETS[grain];
  if (!bucket) throw new Error(`Unknown grain ${grain}`);
  const inList = Array.from({ length: locationCount }, () => '?').join(',');
  return `WITH t AS (
      SELECT location_id AS g, ${bucket} AS b, minutes FROM ticket_times
      WHERE business_date BETWEEN ? AND ? AND location_id IN (${inList})
    ),
    u AS (SELECT g, b, minutes FROM t UNION ALL SELECT '_all', b, minutes FROM t),
    r AS (
      SELECT g, b, minutes,
        ROW_NUMBER() OVER (PARTITION BY g, b ORDER BY minutes) AS rn,
        COUNT(*) OVER (PARTITION BY g, b) AS n,
        SUM(minutes > 20) OVER (PARTITION BY g, b) AS over
      FROM u
    )
    SELECT g AS location_id, b AS bucket, n, over, AVG(minutes) AS median
    FROM r WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
    GROUP BY g, b`;
}

// --- By hour: demand, staffing & ticket time -----------------------------------
// A location gets the chart only if it has timed tickets and at least 6
// date-hours with 3+ orders, 0.25+ kitchen staff hours and a timed ticket.
export const STAFFING_GATE = { minOrders: 3, minKitchenHours: 0.25, minUnits: 6 };

/**
 * Toast job titles that count as kitchen staff (exact, case-insensitive). The
 * KITCHEN_JOB_TITLES variable (comma-separated) overrides this list.
 */
export const DEFAULT_KITCHEN_JOB_TITLES = 'Kitchen,Expo';
export function kitchenTitleList(env) {
  return String(env?.KITCHEN_JOB_TITLES || DEFAULT_KITCHEN_JOB_TITLES).split(',').map((t) => t.trim()).filter(Boolean);
}
export function kitchenTitles(env) {
  return new Set(kitchenTitleList(env).map((t) => t.toLowerCase()));
}

const add = (map, key, v) => map.set(key, (map.get(key) || 0) + v);

/**
 * Averages per hour of day. orders / kitchen: Map("date|hour" -> orders /
 * kitchen staff hours); tickets: Map("date|hour" -> [minutes]). An hour's
 * days are the dates with an order in it, and its kitchen staff counts only
 * those dates' kitchen hours: prep or closing crew on days without orders in
 * that hour would otherwise inflate early and late hours (one 7am order on one
 * day plus a prep cook every morning read as dozens of cooks). Hours averaging
 * < 1 order are left out; hours run in business-day order from 4am, so 12a
 * follows 11p. [{ hour, orders (1 dp), kitchenStaff (2 dp), median (1 dp) | null }].
 */
export function hourlyRows(orders, kitchen, tickets) {
  const days = new Map();
  const ordc = new Map();
  const kh = new Map();
  const tks = new Map();
  for (const [key, n] of orders) {
    const [d, h] = key.split('|');
    const hour = Number(h);
    if (!days.has(hour)) days.set(hour, new Set());
    days.get(hour).add(d);
    add(ordc, hour, n);
    add(kh, hour, kitchen.get(key) || 0);
  }
  for (const [key, v] of tickets) {
    const hour = Number(key.split('|')[1]);
    if (!tks.has(hour)) tks.set(hour, []);
    tks.get(hour).push(...v);
  }
  const rows = [];
  const fromOpen = (h) => (h + 24 - CLOSEOUT_HOUR) % 24;
  for (const hour of [...days.keys()].sort((a, b) => fromOpen(a) - fromOpen(b))) {
    const nd = days.get(hour).size || 1;
    const avg = (ordc.get(hour) || 0) / nd;
    if (avg < 1) continue;
    const t = tks.get(hour);
    rows.push({
      hour,
      orders: roundHalfEven(avg, 1),
      kitchenStaff: roundHalfEven((kh.get(hour) || 0) / nd, 2),
      median: t?.length ? roundHalfEven(median(t), 1) : null,
    });
  }
  return rows;
}

/**
 * input: { orders: [{ date, hour, orders }], kitchen: [{ date, hour, hours }],
 * tickets: [{ date, hour, minutes }] }, dates local. Returns { rows (null when
 * the gate fails), gate: { timedTickets, kitchenHours, units, passed } }.
 */
export function buildHourlyProfile({ orders = [], kitchen = [], tickets = [] }) {
  const ord = new Map();
  for (const r of orders) if (Number(r.orders) > 0) add(ord, `${r.date}|${Number(r.hour)}`, Number(r.orders));
  const kit = new Map();
  for (const r of kitchen) add(kit, `${r.date}|${Number(r.hour)}`, Number(r.hours) || 0);
  const tk = new Map();
  for (const r of tickets) {
    const key = `${r.date}|${Number(r.hour)}`;
    if (!tk.has(key)) tk.set(key, []);
    tk.get(key).push(Number(r.minutes));
  }
  const g = STAFFING_GATE;
  let units = 0;
  for (const [key, n] of ord) {
    if (n >= g.minOrders && (kit.get(key) || 0) >= g.minKitchenHours && tk.get(key)?.length) units++;
  }
  const gate = {
    timedTickets: tickets.length,
    kitchenHours: roundHalfEven([...kit.values()].reduce((a, b) => a + b, 0), 1),
    units,
    passed: tickets.length > 0 && units >= g.minUnits,
  };
  if (!gate.passed) return { rows: null, gate };
  const rows = hourlyRows(ord, kit, tk);
  return { rows: rows.length ? rows : null, gate };
}

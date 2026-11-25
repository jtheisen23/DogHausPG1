// Kitchen ticket-time heatmap (Kitchen tab). Ticket times come from the sync
// (ticket_times: one row per order whose kitchen bumped it to READY on the
// Toast KDS); this turns a location's rows into the weekday x hour grid.

/** Python-style round(x, digits): halves go to the even neighbour. */
export function roundHalfEven(x, digits = 0) {
  const f = 10 ** digits;
  const v = x * f;
  const r = Math.round(v);
  const isHalf = Math.abs(v - Math.trunc(v)) === 0.5;
  return (isHalf && r % 2 !== 0 ? r - 1 : r) / f;
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

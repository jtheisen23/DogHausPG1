// Minimal 7shifts API v2 client (read-only), the shift -> scheduled labor
// aggregation, and the time punch -> actual labor aggregation used by
// sevenshifts-sync.js.
//
// Docs: https://developers.7shifts.com/reference

import { eachDate } from './dates.js';
import { lit } from './sql.js';

const DEFAULT_HOST = 'https://api.7shifts.com';
const PAGE_SIZE = 500;

export class SevenShiftsClient {
  constructor({ token, host = DEFAULT_HOST, minIntervalMs = 150, log = console.error }) {
    if (!token) throw new Error('SEVENSHIFTS_ACCESS_TOKEN is required');
    this.token = token;
    this.host = host.replace(/\/$/, '');
    this.minIntervalMs = minIntervalMs;
    this.log = log;
    this.lastRequestAt = 0;
  }

  async get(path, query = {}) {
    const url = new URL(this.host + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } });
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        this.log(`7shifts ${res.status} on ${url.pathname}; retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      const err = new Error(`7shifts GET ${url.pathname} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
  }

  /** Follows cursor pagination and returns every record in `data`. */
  async list(path, query = {}) {
    const all = [];
    let cursor;
    for (let page = 0; page < 200; page++) {
      const body = await this.get(path, { limit: PAGE_SIZE, ...query, cursor });
      const data = Array.isArray(body?.data) ? body.data : [];
      all.push(...data);
      cursor = body?.meta?.cursor?.next;
      if (!cursor || !data.length) break;
    }
    return all;
  }

  /** The company this token belongs to. */
  async company() {
    const companies = await this.list('/v2/companies');
    if (!companies.length) throw new Error('The 7shifts token has no company');
    if (companies.length > 1) this.log(`Token sees ${companies.length} companies; using ${companies[0].id}`);
    return companies[0];
  }

  locations(companyId) {
    return this.list(`/v2/company/${companyId}/locations`);
  }

  roles(companyId, locationId) {
    return this.list(`/v2/company/${companyId}/roles`, { location_id: locationId });
  }

  /** Published, non-deleted shifts starting between two ISO instants. */
  shifts(companyId, locationId, startIso, endIso) {
    return this.list(`/v2/company/${companyId}/shifts`, {
      location_id: locationId,
      'start[gte]': startIso,
      'start[lte]': endIso,
      deleted: false,
      draft: false,
    });
  }

  /** Clock-in/clock-out punches (actual hours worked) clocked in between two ISO instants. */
  timePunches(companyId, locationId, startIso, endIso) {
    return this.list(`/v2/company/${companyId}/time_punches`, {
      location_id: locationId,
      'clocked_in[gte]': startIso,
      'clocked_in[lte]': endIso,
      deleted: false,
    });
  }

  /** Log book posts for one location and date (the API ignores date ranges). */
  logBookPosts(companyId, locationId, date) {
    return this.list(`/v2/company/${companyId}/log_book_posts`, { location_id: locationId, date });
  }

  /** Every log book post a location has. */
  allLogBookPosts(companyId, locationId) {
    return this.list(`/v2/company/${companyId}/log_book_posts`, { location_id: locationId });
  }

  logBookCategories(companyId, locationId) {
    return this.list(`/v2/company/${companyId}/log_book_categories`, { location_id: locationId });
  }

  /** Comments for a batch of posts. */
  logBookComments(companyId, postIds) {
    return this.list(`/v2/company/${companyId}/log_book_comments`, { log_book_ids: postIds.join(',') });
  }

  /** id -> display name for every user in the company. */
  async userNames(companyId) {
    const users = await this.list(`/v2/company/${companyId}/users`);
    return new Map(users.map((u) => [u.id, displayName(u)]));
  }

  /**
   * 7shifts' own Daily Sales & Labor report for one location (The Works plan
   * or higher), as returned. Used by the connection check to compare the
   * dashboard's labor with what 7shifts shows.
   */
  async dailySalesAndLabor(companyId, locationId, startDate, endDate) {
    const query = { location_id: locationId, start_date: startDate, end_date: endDate };
    try {
      return await this.get('/v2/reports/daily_sales_and_labor', query);
    } catch (err) {
      if (err.status !== 404) throw err;
      return this.get(`/v2/company/${companyId}/reports/daily_sales_and_labor`, query);
    }
  }

  /** Current wages of one user; used when a shift has no wage on it. */
  async userWages(companyId, userId) {
    const body = await this.get(`/v2/company/${companyId}/users/${userId}/wages`);
    return body?.data?.current_wages ?? [];
  }
}

export function displayName(u) {
  const first = u?.preferred_first_name || u?.first_name || '';
  const last = u?.preferred_last_name || u?.last_name || '';
  return `${first} ${last}`.trim();
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Pairs each dashboard location with a 7shifts location: an explicit
 * `sevenShiftsId` in the location config wins, otherwise the 7shifts name
 * must contain the dashboard name (e.g. "MÓGŪ Modern Chinese Kitchen – Holbrook" ~ "Holbrook").
 */
export function matchLocations(configured, remote) {
  const out = [];
  for (const loc of configured) {
    let match = null;
    if (loc.sevenShiftsId) match = remote.find((r) => String(r.id) === String(loc.sevenShiftsId)) || null;
    if (!match) {
      const want = norm(loc.name);
      const hits = remote.filter((r) => norm(r.name).includes(want) || (norm(r.name) && want.includes(norm(r.name))));
      if (hits.length === 1) match = hits[0];
    }
    out.push({ loc, remote: match });
  }
  return out;
}

const dateFormatters = new Map();
/** Local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(iso, timeZone) {
  let f = dateFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(timeZone, f);
  }
  return f.format(new Date(iso));
}

/** UTC instant of local midnight on `date` in `timeZone`. */
export function localMidnightUtc(date, timeZone) {
  const guess = new Date(`${date}T00:00:00Z`);
  // Offset of the zone at that moment, e.g. -7h for PDT.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(guess).map((p) => [p.type, p.value]),
  );
  const asLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Unpaid break minutes on a shift, whichever way 7shifts reports them. */
function unpaidBreakMinutes(s) {
  if (Array.isArray(s.breaks)) {
    return s.breaks
      .filter((b) => !b.paid && b.is_paid !== true && String(b.type ?? '').toLowerCase() !== 'paid')
      .reduce((m, b) => m + (num(b.duration_override_min) || num(b.length) || num(b.duration) || num(b.minutes)), 0);
  }
  return num(s.unpaid_break_minutes) || num(s.break_minutes) || 0;
}

/** Wage in dollars per hour. 7shifts v2 reports wages in cents. */
export function shiftWage(s, userWage) {
  const cents = num(s.hourly_wage) || num(s.wage_cents) || num(userWage);
  return cents / 100;
}

/**
 * Turns shifts into rows of { business_date, role, shifts, employees, hours,
 * cost, open_shifts, open_hours } for one location. Shifts are dated by their
 * local start time. `excludedRoles` are lower-cased names to leave out.
 * Salaried people's shifts (`salaried(s)`) count toward hours, as in 7shifts,
 * but not toward hours x wage cost: their pay is added from their salary.
 */
export function aggregateShifts(shifts, { timeZone, roles, wageFor = () => 0, excludedRoles = [], salaried = () => false }) {
  const skip = new Set(excludedRoles.map((r) => r.toLowerCase()));
  const roleName = (id) => roles.get(id) || (id ? `Role ${id}` : 'No role');
  const groups = new Map();
  for (const s of shifts) {
    if (s.deleted || s.soft_deleted || s.draft) continue;
    const start = Date.parse(s.start);
    const end = Date.parse(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const role = roleName(s.role_id);
    if (skip.has(role.trim().toLowerCase())) continue;
    const date = localDate(s.start, timeZone);
    const key = `${date}|${role}`;
    let g = groups.get(key);
    if (!g) {
      g = { business_date: date, role, shifts: 0, users: new Set(), hours: 0, cost: 0, open_shifts: 0, open_hours: 0 };
      groups.set(key, g);
    }
    const hours = Math.max(0, (end - start) / 3600000 - unpaidBreakMinutes(s) / 60);
    if (s.open || !s.user_id) {
      g.open_shifts++;
      g.open_hours += hours;
      continue;
    }
    g.shifts++;
    g.users.add(s.user_id);
    g.hours += hours;
    if (!salaried(s)) g.cost += hours * shiftWage(s, wageFor(s));
  }
  return [...groups.values()].map(({ users, ...g }) => ({
    ...g,
    employees: users.size,
    hours: round2(g.hours),
    cost: round2(g.cost),
    open_hours: round2(g.open_hours),
  }));
}

const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Actual labor from time punches
// ---------------------------------------------------------------------------

// A "wage" above this many cents an hour is a salary figure, not an hourly rate.
export const IMPLAUSIBLE_HOURLY_CENTS = 10000;

/** Hourly wage in cents a user has for a role (7shifts user wages), or 0. */
export function hourlyWageCents(wages, roleId) {
  const hourly = (wages || []).filter((w) => !w.wage_type || w.wage_type === 'hourly');
  return num((hourly.find((w) => w.role_id === roleId) || hourly[0])?.wage_cents);
}

/**
 * The wage (cents/hour) labor is costed at: the one on the shift or punch,
 * else the person's hourly 7shifts wage for the role.
 */
export function effectiveWageCents(wages, roleId, cents = 0) {
  return num(cents) || hourlyWageCents(wages, roleId);
}

/**
 * True when the person is salaried for this role: their 7shifts wage for the
 * role (or, without one, every wage they have) is not hourly, or the wage on
 * the shift/punch is a salary-sized number. Salaried pay is not hours x rate,
 * so those shifts and punches count as hours only; the location's
 * salariedLaborPerDay setting covers their pay instead.
 */
export function isSalaried(wages, roleId, cents = 0) {
  if (num(cents) > IMPLAUSIBLE_HOURLY_CENTS) return true;
  const list = wages || [];
  const forRole = list.filter((w) => w.role_id === roleId);
  const relevant = forRole.length ? forRole : list;
  return relevant.length > 0 && relevant.every((w) => w.wage_type && w.wage_type !== 'hourly');
}

/** Paid hours on a punch: clocked time minus unpaid breaks. Null while still clocked in. */
export function punchHours(p) {
  const a = Date.parse(p.clocked_in);
  const b = Date.parse(p.clocked_out);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  let unpaid = 0;
  for (const br of Array.isArray(p.breaks) ? p.breaks : []) {
    if (!br || br.deleted || br.paid === true || br.is_paid === true) continue;
    const i = Date.parse(br.in);
    const o = Date.parse(br.out);
    if (Number.isFinite(i) && Number.isFinite(o) && o > i) unpaid += Math.min(o, b) - Math.max(i, a);
  }
  return Math.max(0, (b - a - Math.max(0, unpaid)) / 3600000);
}

/**
 * Workweek start day from the SEVENSHIFTS_WEEK_START setting: 0 = Sunday,
 * 1 = Monday (the default). Unset or empty means Monday: GitHub passes an
 * unset repository variable as "", which once made it Sunday.
 */
export function weekStartSetting(value) {
  const s = String(value ?? '').trim();
  const n = Number(s);
  return s !== '' && Number.isInteger(n) && n >= 0 && n <= 6 ? n : 1;
}

/** First day (YYYY-MM-DD) of the workweek containing `date`; weekStart 0 = Sunday, 1 = Monday. */
export function weekStartOf(date, weekStart = 1) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - weekStart + 7) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Splits each item's hours into regular and overtime: hours past
 * `weeklyLimit` in a workweek, per employee, across every location, in
 * clock-in order. Items are { user_id, clockedIn (ms), date, hours, salaried };
 * adds `regular` and `overtime` to each and returns them. Salaried items never
 * have overtime.
 */
export function allocateOvertime(items, { weekStart = 1, weeklyLimit = 40 } = {}) {
  const worked = new Map();
  for (const it of [...items].sort((a, b) => a.clockedIn - b.clockedIn)) {
    if (it.salaried) {
      it.regular = it.hours;
      it.overtime = 0;
      continue;
    }
    const key = `${it.user_id}|${weekStartOf(it.date, weekStart)}`;
    const before = worked.get(key) || 0;
    it.regular = Math.max(0, Math.min(it.hours, weeklyLimit - before));
    it.overtime = it.hours - it.regular;
    worked.set(key, before + it.hours);
  }
  return items;
}

/**
 * labor_daily rows for one location from punch items ({ date, role, user_id,
 * wage ($/h), regular, overtime, salaried }), by business date and role.
 * Salaried items add hours but no cost (wage 0); `salaried_hours` reports
 * them and is not stored.
 */
export function punchLaborRows(items, { overtimeMultiplier = 1.5 } = {}) {
  const groups = new Map();
  for (const it of items) {
    const key = `${it.date}|${it.role}`;
    let g = groups.get(key);
    if (!g) {
      g = { business_date: it.date, job_title: it.role, users: new Set(), shifts: 0, regular_hours: 0, overtime_hours: 0, regular_cost: 0, overtime_cost: 0, salaried_hours: 0 };
      groups.set(key, g);
    }
    g.users.add(it.user_id);
    g.shifts++;
    g.regular_hours += it.regular;
    g.overtime_hours += it.overtime;
    g.regular_cost += it.regular * it.wage;
    g.overtime_cost += it.overtime * it.wage * overtimeMultiplier;
    if (it.salaried) g.salaried_hours += it.hours;
  }
  return [...groups.values()]
    .map(({ users, ...g }) => ({
      ...g,
      employees: users.size,
      regular_hours: round2(g.regular_hours),
      overtime_hours: round2(g.overtime_hours),
      regular_cost: round2(g.regular_cost),
      overtime_cost: round2(g.overtime_cost),
      salaried_hours: round2(g.salaried_hours),
    }))
    .sort((a, b) => a.business_date.localeCompare(b.business_date) || a.job_title.localeCompare(b.job_title));
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * A wage's salary allocation days as weekday numbers (0 = Sunday). Accepts day
 * names ("monday", "Mon") or { monday: true } objects. Empty (all 7 days) when
 * unset; null when the format isn't recognized.
 */
export function allocationDays(value) {
  if (value === undefined || value === null) return [];
  const fromName = (s) => WEEKDAYS.indexOf(String(s).trim().slice(0, 3).toLowerCase());
  let days;
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === 'string')) return null;
    days = value.map(fromName);
  } else if (typeof value === 'object') {
    days = Object.entries(value).filter(([, on]) => on === true || on === 1).map(([k]) => fromName(k));
  } else {
    return null;
  }
  return days.some((d) => d < 0) ? null : [...new Set(days)].sort();
}

/**
 * A wage's salary split across 7shifts locations as [{ remoteId, share (0-1) }],
 * from allocations like [{ location_id, percentage }]. Shares are normalized
 * to add up to 1, whatever scale the percentages use. Null when there are no
 * allocations or no location/percentage fields are found.
 */
export function allocationShares(allocations) {
  if (!Array.isArray(allocations) || !allocations.length) return null;
  // 7shifts sends { location_id, amount_tenths }; the others are fallbacks.
  const pctKey = (a) => ['amount_tenths', 'percentage', 'percent', 'allocation', 'allocation_percentage', 'share', 'weight', 'value']
    .find((k) => typeof a?.[k] === 'number' || (typeof a?.[k] === 'string' && a[k].trim() !== '' && Number.isFinite(Number(a[k]))));
  const byLoc = new Map();
  for (const a of allocations) {
    const loc = a?.location_id ?? a?.location?.id;
    const k = pctKey(a);
    if (loc === undefined || loc === null || !k) return null;
    byLoc.set(loc, (byLoc.get(loc) || 0) + Number(a[k]));
  }
  const total = [...byLoc.values()].reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;
  return [...byLoc].map(([remoteId, v]) => ({ remoteId, share: v / total }));
}

/** Weekly salary in cents for a salaried 7shifts wage, or null if the wage type isn't a known salary. */
export function weeklySalaryCents(wage) {
  const cents = num(wage?.wage_cents);
  switch (String(wage?.wage_type || '').toLowerCase()) {
    case 'weekly_salary':
    case 'weekly':
      return cents;
    case 'annual_salary':
    case 'annual':
    case 'yearly_salary':
      return cents / 52;
    default:
      return null;
  }
}

/**
 * Salaried pay per location, day and role, spread the way 7shifts spreads it:
 * the weekly salary is split across locations by allocation share, then
 * evenly over the wage's allocation days, whether or not the person works
 * them. `salaries` are { role, weeklyCents, days: [0-6] (0 = Sunday; empty =
 * all 7), shares: [{ remoteId, share (0-1) }] }. Returns { remoteId, date, role,
 * cost ($) } for every date from start to end.
 */
export function salaryRows(salaries, start, end) {
  const out = [];
  for (const date of eachDate(start, end)) {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    for (const s of salaries) {
      const days = s.days?.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
      if (!days.includes(weekday) || !(s.weeklyCents > 0)) continue;
      for (const { remoteId, share } of s.shares) {
        if (share > 0) out.push({ remoteId, date, role: s.role, cost: (s.weeklyCents / 100) * share / days.length });
      }
    }
  }
  return out;
}

const LABOR_ROW = { role: 'job_title', cost: 'regular_cost', blank: { employees: 0, shifts: 0, regular_hours: 0, overtime_hours: 0, regular_cost: 0, overtime_cost: 0, salaried_hours: 0 } };
export const SCHEDULED_ROW = { role: 'role', cost: 'cost', blank: { shifts: 0, employees: 0, hours: 0, cost: 0, open_shifts: 0, open_hours: 0 } };

/**
 * Adds salaried pay ({ date, role, cost }) to that day's row for the role
 * (labor_daily rows by default, or SCHEDULED_ROW), adding a row without hours
 * where there is none: a salaried manager who didn't work still costs their
 * salary, as in 7shifts.
 */
export function addSalaries(rows, salaries, { role = LABOR_ROW.role, cost = LABOR_ROW.cost, blank = LABOR_ROW.blank } = {}) {
  const byKey = new Map(rows.map((r) => [`${r.business_date}|${r[role]}`, r]));
  for (const s of salaries) {
    const key = `${s.date}|${s.role}`;
    let r = byKey.get(key);
    if (!r) {
      r = { business_date: s.date, [role]: s.role, ...blank };
      byKey.set(key, r);
      rows.push(r);
    }
    r[cost] = round2(r[cost] + s.cost);
  }
  return rows.sort((a, b) => a.business_date.localeCompare(b.business_date) || String(a[role]).localeCompare(String(b[role])));
}

/**
 * Salaried pay rows ({ remoteId, date, role, cost }) from start to end for the
 * salaried people who worked or were scheduled each workweek. `presence` maps
 * user id -> workweek start -> 7shifts location id -> hours there. Each
 * person's salaried 7shifts wage gives the weekly amount, the allocation days
 * and the location split; without allocations, the salary goes where they
 * worked that week, in proportion to hours. Returns { rows, people, issues }
 * (issues: unrecognized formats, without amounts).
 */
export async function salariedPay(presence, { wagesOf, roleName, start, end }) {
  const rows = [];
  const people = new Set();
  const allocatedPeople = new Set();
  const issues = new Set();
  for (const [userId, weeks] of presence) {
    const wages = (await wagesOf(userId)) || [];
    const salaried = wages.filter((w) => w.wage_type && w.wage_type !== 'hourly');
    if (!salaried.length) continue;
    // One salary per person: the most recent.
    const w = [...salaried].sort((a, b) => String(b.effective_date ?? '').localeCompare(String(a.effective_date ?? '')))[0];
    const weeklyCents = weeklySalaryCents(w);
    if (weeklyCents === null) {
      issues.add(`wage type "${w.wage_type}" isn't a known salary`);
      continue;
    }
    let days = allocationDays(w.enabled_days);
    if (days === null) {
      issues.add(`enabled_days format not recognized (${JSON.stringify(w.enabled_days).slice(0, 80)}); spread over 7 days`);
      days = [];
    }
    const fixedShares = allocationShares(w.allocations);
    for (const [week, locHours] of weeks) {
      const from = week > start ? week : start;
      const weekEnd = addDaysIso(week, 6);
      const to = weekEnd < end ? weekEnd : end;
      if (from > to) continue;
      let shares = fixedShares;
      if (!shares) {
        const total = [...locHours.values()].reduce((s, h) => s + h, 0);
        shares = [...locHours].map(([remoteId, h]) => ({ remoteId, share: total > 0 ? h / total : 1 / locHours.size }));
      }
      people.add(userId);
      if (fixedShares) allocatedPeople.add(userId);
      const allocated = !!fixedShares;
      rows.push(...salaryRows([{ role: roleName(w.role_id), weeklyCents, days, shares }], from, to).map((r) => ({ ...r, allocated, userId })));
    }
  }
  return { rows, people: people.size, allocatedPeople: allocatedPeople.size, issues: [...issues] };
}

/** Records that a user worked/was scheduled `hours` at a 7shifts location in a workweek. */
export function notePresence(presence, userId, week, remoteId, hours) {
  if (!presence.has(userId)) presence.set(userId, new Map());
  const weeks = presence.get(userId);
  if (!weeks.has(week)) weeks.set(week, new Map());
  const locs = weeks.get(week);
  locs.set(remoteId, (locs.get(remoteId) || 0) + Math.max(0, hours));
}

function addDaysIso(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * SQL that replaces a location's actual labor for every day from start to end
 * with labor from 7shifts punches. Labor comes only from 7shifts: anything
 * else stored for those days (e.g. old Toast time entries) is removed, and a
 * day without punches has no hourly labor. Salaried pay (salariedPerDay) is
 * added on every day, as before.
 */
export function laborStatements(locationId, start, end, rows, salariedPerDay = 0) {
  if (!start || !end || end < start) return [];
  const all = rows.filter((r) => r.business_date >= start && r.business_date <= end);
  const salaried = Number(salariedPerDay) || 0;
  if (salaried > 0) {
    for (const date of eachDate(start, end)) {
      all.push({ business_date: date, job_title: 'Salaried', employees: 0, shifts: 0, regular_hours: 0, overtime_hours: 0, regular_cost: round2(salaried), overtime_cost: 0 });
    }
  }
  const stmts = [`DELETE FROM labor_daily WHERE location_id=${lit(locationId)} AND business_date BETWEEN ${lit(start)} AND ${lit(end)};`];
  const cols = ['location_id', 'business_date', 'job_title', 'employees', 'shifts', 'regular_hours', 'overtime_hours', 'regular_cost', 'overtime_cost'];
  for (let i = 0; i < all.length; i += 200) {
    const values = all
      .slice(i, i + 200)
      .map((r) => `(${cols.map((c) => lit(c === 'location_id' ? locationId : r[c])).join(',')})`)
      .join(',\n');
    stmts.push(`INSERT INTO labor_daily (${cols.join(',')}) VALUES\n${values};`);
  }
  return stmts;
}

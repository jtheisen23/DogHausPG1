// Builds idempotent SQL for one location + business date. Values are inlined
// as escaped literals so the same statements can be sent to the D1 REST API
// or written to a file for `wrangler d1 execute --file`.

export function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}

function insert(table, rows, columns) {
  if (!rows.length) return [];
  const out = [];
  // Keep statements comfortably below D1's 100 KB statement limit.
  for (let i = 0; i < rows.length; i += 200) {
    const values = rows
      .slice(i, i + 200)
      .map((r) => `(${columns.map((c) => lit(r[c])).join(',')})`)
      .join(',\n');
    out.push(`INSERT INTO ${table} (${columns.join(',')}) VALUES\n${values};`);
  }
  return out;
}

export function upsertLocationsSql(locations) {
  return locations.map(
    (l, i) =>
      `INSERT INTO locations (id,name,toast_guid,timezone,active,sort_order) VALUES (${[
        l.id,
        l.name,
        l.toastGuid || null,
        l.timezone || 'America/New_York',
        l.active === false ? 0 : 1,
        i,
      ]
        .map(lit)
        .join(',')}) ON CONFLICT(id) DO UPDATE SET name=excluded.name, toast_guid=excluded.toast_guid, timezone=excluded.timezone, active=excluded.active, sort_order=excluded.sort_order;`,
  );
}

const TABLES = ['daily_sales', 'hourly_sales', 'sales_mix', 'item_sales', 'discount_sales', 'ticket_times', 'labor_daily'];
const TICKET_COLUMNS = ['location_id', 'business_date', 'order_guid', 'weekday', 'hour', 'minutes'];
const LABOR_HOURS_COLUMNS = ['location_id', 'business_date', 'local_date', 'hour', 'job_title', 'hours'];
const MIX_COLUMNS = [
  'location_id', 'business_date', 'dimension', 'label', 'orders', 'quantity', 'gross_sales',
  'discounts', 'net_sales',
];

/**
 * Replaces one sales_mix dimension (e.g. 'revenue_center') for a location-day
 * and leaves every other table alone: a cheap re-pull after a mapping fix.
 */
export function mixStatements(locationId, date, sales, dimension) {
  const key = { location_id: locationId, business_date: date };
  return [
    `DELETE FROM sales_mix WHERE location_id=${lit(locationId)} AND business_date=${lit(date)} AND dimension=${lit(dimension)};`,
    ...insert('sales_mix', sales.mix.filter((r) => r.dimension === dimension).map((r) => ({ ...key, ...r })), MIX_COLUMNS),
  ];
}

/** Replaces a location-day's hours on the clock by local hour and job (labor_hours). */
export function laborHoursStatements(locationId, date, rows) {
  const key = { location_id: locationId, business_date: date };
  return [
    `DELETE FROM labor_hours WHERE location_id=${lit(locationId)} AND business_date=${lit(date)};`,
    ...insert('labor_hours', rows.map((r) => ({ ...key, ...r })), LABOR_HOURS_COLUMNS),
  ];
}

/**
 * Replaces a location-day's Kitchen tab data (KDS ticket times and, when
 * given, hours on the clock by hour) and leaves every other table alone: loads
 * it for days synced before it was collected.
 */
export function kitchenStatements(locationId, date, sales, laborHours = null) {
  const key = { location_id: locationId, business_date: date };
  return [
    `DELETE FROM ticket_times WHERE location_id=${lit(locationId)} AND business_date=${lit(date)};`,
    ...insert('ticket_times', (sales.tickets ?? []).map((r) => ({ ...key, ...r })), TICKET_COLUMNS),
    ...(laborHours ? laborHoursStatements(locationId, date, laborHours) : []),
  ];
}

/**
 * @param {string} locationId
 * @param {string} date        YYYY-MM-DD
 * @param {object} sales       output of aggregateOrders (or null to leave sales untouched)
 * @param {object[]} labor     output of aggregateLabor (or null to leave labor untouched)
 */
/** Removes a location's rows dated before its startDate (pre-opening test orders, training labor). */
export function purgeBeforeStatements(locationId, startDate) {
  const where = `WHERE location_id=${lit(locationId)} AND business_date < ${lit(startDate)}`;
  return [...TABLES, 'labor_hours', 'scheduled_labor', 'log_book_posts', 'sync_log'].map((t) => `DELETE FROM ${t} ${where};`);
}

export function dayStatements(locationId, date, sales, labor, meta = {}, laborHours = null) {
  const key = { location_id: locationId, business_date: date };
  const where = `WHERE location_id=${lit(locationId)} AND business_date=${lit(date)}`;
  const stmts = [];
  const salesTables = TABLES.filter((t) => t !== 'labor_daily');

  if (sales) {
    for (const t of salesTables) stmts.push(`DELETE FROM ${t} ${where};`);
    stmts.push(
      ...insert('daily_sales', [{ ...key, ...sales.daily }], [
        'location_id', 'business_date', 'orders', 'checks', 'guests', 'gross_sales', 'discounts',
        'net_sales', 'voids', 'void_count', 'service_charges', 'tax', 'tips',
      ]),
      ...insert('hourly_sales', sales.hourly.map((r) => ({ ...key, ...r })), [
        'location_id', 'business_date', 'hour', 'orders', 'guests', 'net_sales',
      ]),
      ...insert('sales_mix', sales.mix.map((r) => ({ ...key, ...r })), MIX_COLUMNS),
      ...insert('item_sales', sales.items.map((r) => ({ ...key, ...r })), [
        'location_id', 'business_date', 'item_name', 'sales_category', 'quantity', 'gross_sales', 'net_sales',
      ]),
      ...insert('discount_sales', sales.discounts.map((r) => ({ ...key, ...r })), [
        'location_id', 'business_date', 'discount_name', 'approver', 'uses', 'amount',
      ]),
      ...insert('ticket_times', (sales.tickets ?? []).map((r) => ({ ...key, ...r })), TICKET_COLUMNS),
    );
  }
  if (labor) {
    stmts.push(`DELETE FROM labor_daily ${where};`);
    stmts.push(
      ...insert('labor_daily', labor.map((r) => ({ ...key, ...r })), [
        'location_id', 'business_date', 'job_title', 'employees', 'shifts', 'regular_hours',
        'overtime_hours', 'regular_cost', 'overtime_cost',
      ]),
    );
  }
  if (laborHours) stmts.push(...laborHoursStatements(locationId, date, laborHours));
  stmts.push(
    `INSERT INTO sync_log (location_id,business_date,synced_at,orders,time_entries) VALUES (${[
      locationId,
      date,
      meta.syncedAt || new Date().toISOString(),
      meta.orders ?? 0,
      meta.timeEntries ?? 0,
    ]
      .map(lit)
      .join(',')}) ON CONFLICT(location_id,business_date) DO UPDATE SET synced_at=excluded.synced_at, orders=excluded.orders, time_entries=excluded.time_entries;`,
  );
  return stmts;
}

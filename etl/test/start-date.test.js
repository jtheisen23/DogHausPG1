import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLocations } from '../src/config.js';
import { purgeBeforeStatements } from '../src/sql.js';

const withLocations = (locations, fn) => {
  const saved = process.env.LOCATIONS_JSON;
  process.env.LOCATIONS_JSON = JSON.stringify({ locations });
  try { return fn(); } finally { if (saved === undefined) delete process.env.LOCATIONS_JSON; else process.env.LOCATIONS_JSON = saved; }
};

test('startDate is optional and must be a real date', () => {
  const ok = withLocations([{ id: 'HS', name: 'High Street', startDate: '2026-11-12' }, { id: 'EN', name: 'East' }], () => loadLocations());
  assert.equal(ok[0].startDate, '2026-11-12');
  assert.equal(ok[1].startDate, undefined);
  assert.throws(() => withLocations([{ id: 'HS', name: 'High Street', startDate: '11/12/2026' }], () => loadLocations()), /startDate "11\/12\/2026"/);
  assert.throws(() => withLocations([{ id: 'HS', name: 'High Street', startDate: '2026-13-40' }], () => loadLocations()), /must be a date/);
});

test('purgeBeforeStatements clears every per-day table before the start date', () => {
  const sql = purgeBeforeStatements('HS', '2026-11-12');
  for (const t of ['daily_sales', 'hourly_sales', 'sales_mix', 'item_sales', 'discount_sales', 'ticket_times', 'labor_daily', 'labor_hours', 'scheduled_labor', 'log_book_posts', 'sync_log']) {
    assert.ok(sql.includes(`DELETE FROM ${t} WHERE location_id='HS' AND business_date < '2026-11-12';`), t);
  }
  assert.equal(sql.length, 11);
});

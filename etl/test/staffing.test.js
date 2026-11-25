import test from 'node:test';
import assert from 'node:assert/strict';
import { accumulateHours, laborHoursByHour } from '../src/transform.js';
import { dayStatements, kitchenStatements } from '../src/sql.js';

const at = (iso) => Date.parse(iso);

test('a shift is split across clock hours by the fraction worked', () => {
  // 4:30pm to 6:15pm in Chicago on Mon Nov 23, 2026 (UTC-6).
  const acc = accumulateHours(new Map(), at('2026-11-23T22:30:00Z'), at('2026-11-24T00:15:00Z'), 'America/Chicago');
  assert.deepEqual(Object.fromEntries(acc), { '2026-11-23|16': 0.5, '2026-11-23|17': 1, '2026-11-23|18': 0.25 });
});

test('a shift past midnight lands on the next local date', () => {
  const acc = accumulateHours(new Map(), at('2026-11-21T05:30:00Z'), at('2026-11-21T06:30:00Z'), 'America/Chicago'); // 11:30pm-12:30am
  assert.deepEqual(Object.fromEntries(acc), { '2026-11-20|23': 0.5, '2026-11-21|0': 0.5 });
});

test('hours on the clock by local hour and job; deleted and still-open shifts are skipped', () => {
  const jobs = new Map([['j-k', 'Kitchen'], ['j-c', 'Cashier']]);
  const rows = laborHoursByHour([
    { inDate: '2026-11-23T17:00:00.000+0000', outDate: '2026-11-23T19:00:00.000+0000', jobReference: { guid: 'j-k' } }, // 11a-1p
    { inDate: '2026-11-23T17:30:00.000+0000', outDate: '2026-11-23T18:00:00.000+0000', jobReference: { guid: 'j-k' } }, // 11:30-12
    { inDate: '2026-11-23T17:00:00.000+0000', outDate: '2026-11-23T18:00:00.000+0000', jobReference: { guid: 'j-c' } },
    { inDate: '2026-11-23T17:00:00.000+0000', outDate: '2026-11-23T18:00:00.000+0000', jobReference: { guid: 'j-k' }, deleted: true },
    { inDate: '2026-11-23T17:00:00.000+0000', jobReference: { guid: 'j-k' } }, // still on the clock
    { inDate: '2026-11-23T17:00:00.000+0000', outDate: '2026-11-23T17:15:00.000+0000' }, // no job
  ], { timezone: 'America/Chicago', lookups: { jobs } });
  assert.deepEqual(rows, [
    { local_date: '2026-11-23', hour: 11, job_title: 'Cashier', hours: 1 },
    { local_date: '2026-11-23', hour: 11, job_title: 'Kitchen', hours: 1.5 },
    { local_date: '2026-11-23', hour: 11, job_title: 'Unassigned', hours: 0.25 },
    { local_date: '2026-11-23', hour: 12, job_title: 'Kitchen', hours: 1 },
  ]);
});

test('labor_hours is replaced per location-day; a day without it leaves it alone', () => {
  const sales = { daily: {}, hourly: [], mix: [], items: [], discounts: [], tickets: [] };
  const rows = [{ local_date: '2026-11-23', hour: 11, job_title: 'Kitchen', hours: 1.5 }];
  const withHours = dayStatements('EN', '2026-11-23', sales, null, {}, rows).join('\n');
  assert.match(withHours, /DELETE FROM labor_hours WHERE location_id='EN' AND business_date='2026-11-23';/);
  assert.match(withHours, /INSERT INTO labor_hours \(location_id,business_date,local_date,hour,job_title,hours\) VALUES\n\('EN','2026-11-23','2026-11-23',11,'Kitchen',1.5\);/);
  assert.doesNotMatch(dayStatements('EN', '2026-11-23', sales, null, {}).join('\n'), /labor_hours/);
  const kitchen = kitchenStatements('EN', '2026-11-23', { tickets: [{ order_guid: 'a', weekday: 0, hour: 12, minutes: 15 }] }, rows);
  assert.equal(kitchen[0], "DELETE FROM ticket_times WHERE location_id='EN' AND business_date='2026-11-23';");
  assert.ok(kitchen.some((x) => x.startsWith('INSERT INTO ticket_times')));
  assert.ok(kitchen.some((x) => x.startsWith('INSERT INTO labor_hours')));
  assert.ok(kitchen.every((x) => !/daily_sales|hourly_sales|sales_mix|labor_daily|sync_log/.test(x)));
  // Without time entries (not readable), a Kitchen-only run leaves labor_hours alone.
  assert.ok(kitchenStatements('EN', '2026-11-23', { tickets: [] }, null).every((x) => !/labor_hours/.test(x)));
});

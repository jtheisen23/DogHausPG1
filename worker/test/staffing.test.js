import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHourlyProfile, hourlyRows, kitchenTitles } from '../src/kitchen.js';

test('hourly averages: orders and kitchen staff per date with orders in that hour', () => {
  const rows = hourlyRows(
    new Map([['2026-11-16|12', 10], ['2026-11-17|12', 6]]),
    new Map([['2026-11-16|12', 3.0], ['2026-11-17|12', 2.0]]),
    new Map([['2026-11-16|12', [12, 14]], ['2026-11-17|12', [20]]]),
  );
  assert.deepEqual(rows, [{ hour: 12, orders: 8, kitchenStaff: 2.5, median: 14 }]);
});

test('an hour averaging under 1 order is left out; no timed ticket gives a null median', () => {
  const rows = hourlyRows(
    new Map([['2026-11-16|12', 4], ['2026-11-16|23', 0], ['2026-11-16|13', 2]]),
    new Map([['2026-11-16|10', 2]]), // prep before opening: not an hour with orders
    new Map(),
  );
  assert.deepEqual(rows.map((r) => r.hour), [12, 13]);
  assert.equal(rows[0].median, null);
  assert.equal(rows[0].kitchenStaff, 0);
});

const busyHours = (n, { orders = 5, hours = 2, ticket = true } = {}) => {
  const out = { orders: [], kitchen: [], tickets: [] };
  for (let i = 0; i < n; i++) {
    const date = `2026-11-${String(9 + i).padStart(2, '0')}`;
    out.orders.push({ date, hour: 12, orders });
    out.kitchen.push({ date, hour: 12, hours });
    if (ticket) out.tickets.push({ date, hour: 12, minutes: 10 + i });
  }
  return out;
};

test('the gate needs timed tickets and 6 date-hours with 3+ orders, 0.25+ kitchen hours and a ticket', () => {
  const ok = buildHourlyProfile(busyHours(6));
  assert.equal(ok.gate.passed, true);
  assert.equal(ok.gate.units, 6);
  assert.deepEqual(ok.rows, [{ hour: 12, orders: 5, kitchenStaff: 2, median: 12.5 }]);

  const few = buildHourlyProfile(busyHours(5));
  assert.equal(few.rows, null);
  assert.deepEqual(few.gate, { timedTickets: 5, kitchenHours: 10, units: 5, passed: false });

  assert.equal(buildHourlyProfile(busyHours(8, { ticket: false })).gate.passed, false); // no KDS bumps
  assert.equal(buildHourlyProfile(busyHours(8, { hours: 0.2 })).gate.units, 0); // no cook on the clock
  assert.equal(buildHourlyProfile(busyHours(8, { orders: 2 })).gate.units, 0); // too quiet
});

test('kitchen job titles: default "Kitchen", or a comma-separated list, case-insensitive', () => {
  assert.deepEqual([...kitchenTitles({})], ['kitchen']);
  assert.deepEqual([...kitchenTitles({ KITCHEN_JOB_TITLES: ' Kitchen, Expo ,' })], ['kitchen', 'expo']);
});

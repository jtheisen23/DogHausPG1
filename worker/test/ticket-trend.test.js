import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ticketTrendSql } from '../src/kitchen.js';

// Runs the trend SQL on a real SQLite database (node:sqlite) with the
// ticket_times table from the migration, so the medians are checked end to end.
const { DatabaseSync } = await import('node:sqlite');

function db(rows) {
  const d = new DatabaseSync(':memory:');
  d.exec(readFileSync(new URL('../../db/migrations/0009_ticket_times.sql', import.meta.url), 'utf8'));
  const ins = d.prepare('INSERT INTO ticket_times (location_id, business_date, order_guid, weekday, hour, minutes) VALUES (?, ?, ?, ?, ?, ?)');
  rows.forEach(([loc, date, hour, minutes], i) => ins.run(loc, date, `o${i}`, 0, hour, minutes));
  return d;
}
const run = (d, grain, start, end, locs) => {
  const rows = d.prepare(ticketTrendSql(grain, locs.length)).all(start, end, ...locs);
  return Object.fromEntries(rows.map((r) => [`${r.location_id}|${r.bucket}`, { n: r.n, over: r.over, median: r.median }]));
};

const ROWS = [
  // Mon Nov 16 and Tue Nov 17 (same week), Mon Nov 23 (next week).
  ['EN', '2026-11-16', 12, 10], ['EN', '2026-11-16', 12, 14], ['EN', '2026-11-16', 18, 25],
  ['EN', '2026-11-17', 12, 30], ['EN', '2026-11-17', 13, 8],
  ['FR', '2026-11-16', 12, 12], ['FR', '2026-11-16', 18, 22],
  ['EN', '2026-11-23', 12, 9],
  ['HS', '2026-11-16', 12, 99], // not requested
];

test('day: median, count and over-20 per location and pooled', () => {
  const r = run(db(ROWS), 'day', '2026-11-16', '2026-11-17', ['EN', 'FR']);
  assert.deepEqual(r['EN|2026-11-16'], { n: 3, over: 1, median: 14 });
  assert.deepEqual(r['EN|2026-11-17'], { n: 2, over: 1, median: 19 }); // even count: mean of the middle two
  assert.deepEqual(r['FR|2026-11-16'], { n: 2, over: 1, median: 17 });
  assert.deepEqual(r['_all|2026-11-16'], { n: 5, over: 2, median: 14 }); // 10 12 14 22 25
  assert.equal(r['HS|2026-11-16'], undefined);
  assert.equal(r['EN|2026-11-23'], undefined); // outside the dates
});

test('week buckets start on Monday; month buckets on the 1st', () => {
  const d = db(ROWS);
  const w = run(d, 'week', '2026-11-16', '2026-11-29', ['EN']);
  assert.deepEqual(w['EN|2026-11-16'], { n: 5, over: 2, median: 14 }); // 8 10 14 25 30
  assert.deepEqual(w['EN|2026-11-23'], { n: 1, over: 0, median: 9 });
  const m = run(d, 'month', '2026-11-01', '2026-11-30', ['EN', 'FR']);
  assert.deepEqual(m['_all|2026-11-01'], { n: 8, over: 3, median: 13 }); // 8 9 10 12 | 14 22 25 30
});

test('hour buckets pool every day in the range', () => {
  const r = run(db(ROWS), 'hour', '2026-11-16', '2026-11-17', ['EN']);
  assert.deepEqual(r['EN|12'], { n: 3, over: 1, median: 14 }); // 10 14 30
  assert.deepEqual(r['EN|18'], { n: 1, over: 1, median: 25 });
});

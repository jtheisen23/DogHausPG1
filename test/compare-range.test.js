import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRange, fmtWeekday } from '../public/js/util.js';

const prev = (start, end) => compareRange('prev', { start, end });

test('one day compares with the same weekday last week', () => {
  assert.deepEqual(prev('2026-11-23', '2026-11-23'), { start: '2026-11-16', end: '2026-11-16' });
  assert.equal(fmtWeekday('2026-11-16'), fmtWeekday('2026-11-23'));
});

test('a partial week compares with the same days of the prior week', () => {
  assert.deepEqual(prev('2026-11-23', '2026-11-24'), { start: '2026-11-16', end: '2026-11-17' });
});

test('seven days compare with the seven days before', () => {
  assert.deepEqual(prev('2026-11-17', '2026-11-23'), { start: '2026-11-10', end: '2026-11-16' });
});

test('longer ranges go back whole weeks without overlapping', () => {
  const r = prev('2026-11-01', '2026-11-24'); // 24 days -> 4 weeks back
  assert.deepEqual(r, { start: '2026-10-04', end: '2026-10-27' });
  assert.ok(r.end < '2026-11-01');
  assert.equal(fmtWeekday(r.start), fmtWeekday('2026-11-01'));
  const m = prev('2026-10-26', '2026-11-24'); // 30 days -> 5 weeks back
  assert.deepEqual(m, { start: '2026-09-21', end: '2026-10-20' });
  assert.ok(m.end < '2026-10-26');
});

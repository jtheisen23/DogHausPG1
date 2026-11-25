import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTicketHeatmap, completedWeeks, roundHalfEven, todayIn } from '../src/kitchen.js';

const rows = (weekday, hour, minutes) => minutes.map((m) => ({ weekday, hour, minutes: m }));

test('cells give the median, ticket count and % over 20 minutes; thin cells are left out', () => {
  const heat = buildTicketHeatmap([
    ...rows(1, 18, [12, 17, 18, 25]), // Tue 6p: median 17.5, 1 of 4 over 20 -> 25%
    ...rows(4, 12, [8, 9, 30]), // Fri 12p: median 9, 1 of 3 over 20 -> 33%
    ...rows(6, 11, [10, 11]), // Sun 11a: only 2 tickets -> left out
  ]);
  assert.deepEqual(heat.cells['1-18'], { median: 17.5, n: 4, over: 25 });
  assert.deepEqual(heat.cells['4-12'], { median: 9, n: 3, over: 33 });
  assert.equal(heat.cells['6-11'], undefined);
  assert.deepEqual(heat.hours, [12, 18]); // only hours with a kept cell
});

test('no cell with 3+ tickets means no heatmap', () => {
  assert.equal(buildTicketHeatmap([]), null);
  assert.equal(buildTicketHeatmap(rows(0, 12, [10, 11])), null);
});

test('rounding matches Python round(): halves go to the even neighbour', () => {
  assert.equal(roundHalfEven(32.5), 32);
  assert.equal(roundHalfEven(33.5), 34);
  assert.equal(roundHalfEven(17.25, 1), 17.2);
  assert.equal(roundHalfEven(17.35, 1), 17.4);
  assert.equal(roundHalfEven(12.34, 1), 12.3);
});

test('the window is the 8 complete Monday-Sunday weeks before the current week', () => {
  // Tuesday Nov 24, 2026: this week (Nov 23-29) is in progress.
  assert.deepEqual(completedWeeks('2026-11-24'), { start: '2026-09-28', end: '2026-11-22' });
  // On a Monday the week that just ended counts.
  assert.deepEqual(completedWeeks('2026-11-23'), { start: '2026-09-28', end: '2026-11-22' });
  // On a Sunday that week is still in progress.
  assert.deepEqual(completedWeeks('2026-11-29'), { start: '2026-09-28', end: '2026-11-22' });
});

test('todayIn uses the location time zone', () => {
  const now = new Date('2026-11-25T03:00:00Z');
  assert.equal(todayIn('America/Chicago', now), '2026-11-24');
  assert.equal(todayIn('UTC', now), '2026-11-25');
});

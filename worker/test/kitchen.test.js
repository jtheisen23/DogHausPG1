import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrdersHeatmap, buildTicketHeatmap, calendarDate, completedWeeks, ordersHeatmapPayload, roundHalfEven, todayIn, weekdayOf,
} from '../src/kitchen.js';

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
  // Python rounds the stored value: 0.15 is 0.1499..., 0.35 is 0.3499..., 2.675 is 2.67499...
  assert.equal(roundHalfEven(0.15, 1), 0.1);
  assert.equal(roundHalfEven(0.35, 1), 0.3);
  assert.equal(roundHalfEven(2.675, 2), 2.67);
  assert.equal(roundHalfEven(1.25, 1), 1.2);
  assert.equal(roundHalfEven(1.75, 1), 1.8);
  assert.equal(roundHalfEven(3, 1), 3);
  assert.equal(roundHalfEven(10 / 3, 1), 3.3);
  assert.equal(roundHalfEven(0), 0);
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

// --- Average orders by hour & day -------------------------------------------
const rowsFor = (date, hour, orders) => ({ date, hour, orders });

test('orders heatmap: average per operating date, hours open on < max(2, 40%) of dates left out', () => {
  // Two Mondays: Nov 9 and Nov 16, 2026.
  const heat = buildOrdersHeatmap([
    rowsFor('2026-11-09', 12, 4),
    rowsFor('2026-11-16', 12, 2),
    rowsFor('2026-11-09', 13, 5), // only one of the two Mondays -> left out
  ]);
  assert.deepEqual(heat, { hours: [12], cells: { '0-12': 3 } });
});

test('orders heatmap: a weekday counts every date with any order; averages round to 1 decimal', () => {
  const heat = buildOrdersHeatmap([
    // Fridays Nov 6, 13, 20: 6p busy all three, 9p only on two of them.
    rowsFor('2026-11-06', 18, 20), rowsFor('2026-11-13', 18, 22), rowsFor('2026-11-20', 18, 23),
    rowsFor('2026-11-06', 21, 4), rowsFor('2026-11-13', 21, 3),
    rowsFor('2026-11-20', 9, 0), // zero rows don't count
  ]);
  assert.equal(heat.cells['4-18'], 21.7); // 65 / 3
  assert.equal(heat.cells['4-21'], 2.3); // 7 / 3, open 2 of 3 Fridays (>= 2 and >= 40%)
  assert.deepEqual(heat.hours, [18, 21]);
  assert.equal(buildOrdersHeatmap([]), null);
  assert.equal(buildOrdersHeatmap([rowsFor('2026-11-09', 12, 4)]), null); // one date can't pass max(2, ...)
});

test('orders heatmap: the 40% rule drops hours open on few of many dates', () => {
  const mondays = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16'];
  const rows = mondays.map((d) => rowsFor(d, 12, 10));
  rows.push(rowsFor(mondays[0], 22, 1), rowsFor(mondays[1], 22, 1), rowsFor(mondays[2], 22, 1)); // 3 of 8 < 40%
  rows.push(rowsFor(mondays[0], 21, 2), rowsFor(mondays[1], 21, 2), rowsFor(mondays[2], 21, 2), rowsFor(mondays[3], 21, 2)); // 4 of 8
  const heat = buildOrdersHeatmap(rows);
  assert.equal(heat.cells['0-12'], 10);
  assert.equal(heat.cells['0-21'], 1); // 8 / 8 dates
  assert.equal(heat.cells['0-22'], undefined);
});

test('after-midnight orders count on the calendar day they were opened', () => {
  assert.equal(calendarDate('2026-11-20', 0), '2026-11-21'); // Friday's business date, Saturday 12:xx am
  assert.equal(calendarDate('2026-11-20', 3), '2026-11-21');
  assert.equal(calendarDate('2026-11-20', 8), '2026-11-20');
  assert.equal(weekdayOf('2026-11-21'), 5);
  assert.equal(weekdayOf('2026-11-23'), 0);
});

test('orders heatmap payload: only locations with a grid, one shared color-scale max', () => {
  const byLoc = { EN: { hours: [12], cells: { '0-12': 3 } }, FR: { hours: [12], cells: { '0-12': 9.5 } } };
  assert.deepEqual(ordersHeatmapPayload(byLoc, ['FR', 'HS', 'EN']), { locations: ['FR', 'EN'], byLoc, max: 9.5 });
  assert.equal(ordersHeatmapPayload(byLoc, ['HS']), null);
});

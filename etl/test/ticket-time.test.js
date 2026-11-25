import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateOrders, ticketReadyMinutes } from '../src/transform.js';
import { weekdayIn } from '../src/dates.js';

const sel = (over) => ({ quantity: 1, price: 10, preDiscountPrice: 10, ...over });

test('ticket time runs from the first item fired to the last item marked READY', () => {
  const checks = [{
    selections: [
      sel({ createdDate: '2026-11-23T12:00:00.000+0000', modifiedDate: '2026-11-23T12:15:00.000+0000', fulfillmentStatus: 'READY' }),
      sel({ createdDate: '2026-11-23T12:02:00.000+0000', modifiedDate: '2026-11-23T12:09:00.000+0000', fulfillmentStatus: 'SENT' }),
    ],
  }];
  assert.equal(ticketReadyMinutes(checks), 15);
});

test('a voided READY item, or no READY item, gives no ticket time', () => {
  const voidedReady = [{
    selections: [
      sel({ createdDate: '2026-11-23T12:00:00.000+0000', fulfillmentStatus: 'SENT' }),
      sel({ createdDate: '2026-11-23T12:02:00.000+0000', modifiedDate: '2026-11-23T12:15:00.000+0000', fulfillmentStatus: 'READY', voided: true }),
    ],
  }];
  assert.equal(ticketReadyMinutes(voidedReady), null);
  const noneReady = [{ selections: [sel({ createdDate: '2026-11-23T12:00:00.000+0000', modifiedDate: '2026-11-23T12:15:00.000+0000', fulfillmentStatus: 'SENT' })] }];
  assert.equal(ticketReadyMinutes(noneReady), null);
  assert.equal(ticketReadyMinutes([]), null);
  const voidedCheck = [{ voided: true, selections: [sel({ createdDate: '2026-11-23T12:00:00.000+0000', modifiedDate: '2026-11-23T12:15:00.000+0000', fulfillmentStatus: 'READY' })] }];
  assert.equal(ticketReadyMinutes(voidedCheck), null);
});

test('a voided item does not move the fired time', () => {
  const checks = [{
    selections: [
      sel({ createdDate: '2026-11-23T11:30:00.000+0000', voided: true }),
      sel({ createdDate: '2026-11-23T12:00:00.000+0000', modifiedDate: '2026-11-23T12:10:30.000+0000', fulfillmentStatus: 'READY' }),
    ],
  }];
  assert.equal(ticketReadyMinutes(checks), 10.5);
});

test('spans outside 0-240 minutes are dropped', () => {
  const late = [{ selections: [sel({ createdDate: '2026-11-23T12:00:00.000+0000', modifiedDate: '2026-11-23T16:00:00.000+0000', fulfillmentStatus: 'READY' })] }];
  assert.equal(ticketReadyMinutes(late), null);
  const backwards = [{ selections: [sel({ createdDate: '2026-11-23T12:00:00.000+0000', modifiedDate: '2026-11-23T11:59:00.000+0000', fulfillmentStatus: 'READY' })] }];
  assert.equal(ticketReadyMinutes(backwards), null);
});

test('weekdayIn uses the local date, Monday = 0', () => {
  // 03:30 UTC Tuesday is still Monday evening in Chicago.
  assert.equal(weekdayIn('2026-11-24T03:30:00.000Z', 'America/Chicago'), 0);
  assert.equal(weekdayIn('2026-11-24T03:30:00.000Z', 'UTC'), 1);
  assert.equal(weekdayIn('2026-11-29T18:00:00.000Z', 'America/New_York'), 6);
  assert.equal(weekdayIn('', 'UTC'), null);
});

test('aggregateOrders lists one ticket per bumped order, in local weekday and hour', () => {
  const order = (guid, opened, status) => ({
    guid,
    openedDate: opened,
    numberOfGuests: 1,
    checks: [{
      selections: [sel({ createdDate: opened, modifiedDate: '2026-11-24T00:20:00.000+0000', fulfillmentStatus: status })],
    }],
  });
  const sales = aggregateOrders([
    order('a', '2026-11-24T00:05:00.000+0000', 'READY'), // Mon 6:05pm Chicago, 15 min
    order('b', '2026-11-24T00:10:00.000+0000', 'SENT'), // not bumped
    { ...order('c', '2026-11-24T00:05:00.000+0000', 'READY'), voided: true }, // voided order
  ], { timezone: 'America/Chicago', lookups: {} });
  assert.equal(sales.daily.orders, 2);
  assert.deepEqual(sales.tickets, [{ order_guid: 'a', weekday: 0, hour: 18, minutes: 15 }]);
});

test('hourly order counts (average orders heatmap) leave out voided orders', () => {
  const order = (guid, opened, extra = {}) => ({
    guid, openedDate: opened, numberOfGuests: 1, ...extra,
    checks: [{ selections: [sel({ createdDate: opened })] }],
  });
  const sales = aggregateOrders([
    order('a', '2026-11-23T18:05:00.000+0000'), // Mon 12:05pm Chicago
    order('b', '2026-11-23T18:40:00.000+0000'),
    order('c', '2026-11-23T18:45:00.000+0000', { voided: true }),
    order('d', '2026-11-23T18:50:00.000+0000', { deleted: true }),
  ], { timezone: 'America/Chicago', lookups: {} });
  assert.deepEqual(sales.hourly.map((r) => [r.hour, r.orders]), [[12, 2]]);
});

test('a tickets-only sync rewrites ticket_times for the day and nothing else', async () => {
  const { ticketStatements } = await import('../src/sql.js');
  const stmts = ticketStatements('EN', '2026-03-14', { tickets: [{ order_guid: 'a', weekday: 5, hour: 12, minutes: 15 }] });
  assert.equal(stmts[0], "DELETE FROM ticket_times WHERE location_id='EN' AND business_date='2026-03-14';");
  assert.equal(stmts.length, 2);
  assert.match(stmts[1], /^INSERT INTO ticket_times \(location_id,business_date,order_guid,weekday,hour,minutes\) VALUES\n\('EN','2026-03-14','a',5,12,15\);$/);
  assert.ok(stmts.every((s) => !/daily_sales|hourly_sales|sales_mix|labor_daily|sync_log/.test(s)));
  assert.deepEqual(ticketStatements('EN', '2026-03-14', { tickets: [] }), ["DELETE FROM ticket_times WHERE location_id='EN' AND business_date='2026-03-14';"]);
});

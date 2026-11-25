import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/api.js';
import { SECTIONS } from '../src/auth.js';

const url = new URL('https://x/api?start=2026-11-18&end=2026-11-24&locations=EN&grain=day');
const salesOnly = { email: 'v@example.com', isAdmin: false, locations: ['EN'], sections: { sales: true, kitchen: false } };

test('Kitchen is its own permission section', () => {
  assert.ok(SECTIONS.includes('kitchen'));
});

test('every Kitchen tab endpoint needs the Kitchen permission, not just Sales', async () => {
  for (const fn of [api.kitchen, api.orderHeatmap, api.ticketTrend, api.staffing]) {
    await assert.rejects(fn({}, url, salesOnly), { status: 403, message: /kitchen/ }, fn.name);
  }
});

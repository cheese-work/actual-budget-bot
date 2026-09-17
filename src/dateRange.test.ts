import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDateRange } from './dateRange.js';

const FIXED_NOW = new Date('2026-09-18T12:00:00Z');

test('empty phrase resolves to this month', () => {
  const range = resolveDateRange('', FIXED_NOW);
  assert.deepEqual(range, { start: '2026-09-01', end: '2026-09-30', label: 'this month' });
});

test('"this month" resolves to current month bounds', () => {
  const range = resolveDateRange('this month', FIXED_NOW);
  assert.deepEqual(range, { start: '2026-09-01', end: '2026-09-30', label: 'this month' });
});

test('"today" resolves to a single-day range', () => {
  const range = resolveDateRange('today', FIXED_NOW);
  assert.deepEqual(range, { start: '2026-09-18', end: '2026-09-18', label: 'today' });
});

test('"yesterday" resolves to the previous day', () => {
  const range = resolveDateRange('yesterday', FIXED_NOW);
  assert.deepEqual(range, { start: '2026-09-17', end: '2026-09-17', label: 'yesterday' });
});

test('"last month" resolves to the previous month bounds', () => {
  const range = resolveDateRange('last month', FIXED_NOW);
  assert.deepEqual(range, { start: '2026-08-01', end: '2026-08-31', label: 'last month' });
});

test('"last month" crosses a year boundary correctly', () => {
  const range = resolveDateRange('last month', new Date('2026-01-15T00:00:00Z'));
  assert.deepEqual(range, { start: '2025-12-01', end: '2025-12-31', label: 'last month' });
});

test('is case-insensitive and trims whitespace', () => {
  const range = resolveDateRange('  YESTERDAY  ', FIXED_NOW);
  assert.deepEqual(range, { start: '2026-09-17', end: '2026-09-17', label: 'yesterday' });
});

test('unrecognized phrase returns undefined', () => {
  assert.equal(resolveDateRange('next tuesday', FIXED_NOW), undefined);
});

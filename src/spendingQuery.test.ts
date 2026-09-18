import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpendingQuery } from './spendingQuery.js';

const FIXED_NOW = new Date('2026-09-18T12:00:00Z');

test('extracts category and "this month" phrase', () => {
  const result = parseSpendingQuery('how much on food this month?', FIXED_NOW);
  assert.equal(result.category, 'food');
  assert.equal(result.range.label, 'this month');
});

test('extracts "yesterday" with no category (total spend)', () => {
  const result = parseSpendingQuery('what did I spend yesterday?', FIXED_NOW);
  assert.equal(result.category, undefined);
  assert.equal(result.range.label, 'yesterday');
});

test('defaults to this month when no date phrase present', () => {
  const result = parseSpendingQuery('how much on groceries', FIXED_NOW);
  assert.equal(result.category, 'groceries');
  assert.equal(result.range.label, 'this month');
});

test('extracts "last month" phrase with category', () => {
  const result = parseSpendingQuery('how much did I spend on transport last month', FIXED_NOW);
  assert.equal(result.category, 'transport');
  assert.equal(result.range.label, 'last month');
});

test('handles "today" with category', () => {
  const result = parseSpendingQuery('spending on coffee today', FIXED_NOW);
  assert.equal(result.category, 'coffee');
  assert.equal(result.range.label, 'today');
});

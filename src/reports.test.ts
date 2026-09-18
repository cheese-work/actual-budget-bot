import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSpendingReport, formatMonthlySummary, type QueryRow } from './reports.js';

test('formatSpendingReport: sums outflows only, ignores income mixed into range', () => {
  // AQL sum of income (+5_000_000) and expenses (-45000, -30000, -20000)
  // would be 4_905_000. With the income excluded by the $lt: 0 filter,
  // the query returns only the outflow total: -95000.
  const total = -95000;
  const result = formatSpendingReport(total, 'total', 'this month');
  assert.equal(result, 'Spent total for this month: 95.000 ₫');
});

test('formatSpendingReport: expense fully offset by income no longer reads as "nothing spent"', () => {
  // -100000 spend + 100000 income used to sum to 0 and report "Nothing spent".
  // With income excluded from the query, only the -100000 outflow reaches here.
  const total = -100000;
  const result = formatSpendingReport(total, 'total', 'today');
  assert.equal(result, 'Spent total for today: 100.000 ₫');
});

test('formatSpendingReport: genuinely zero spend still reports "Nothing spent"', () => {
  const result = formatSpendingReport(0, 'total', 'today');
  assert.equal(result, 'Nothing spent total for today.');
});

test('formatMonthlySummary: excludes income categories from the "Spent" table', () => {
  // Simulates AQL rows after the amount < 0 filter: only expense categories
  // are ever returned, so a positive Salary row can no longer appear here.
  const rows: QueryRow[] = [
    { 'category.name': 'Food', amount: -45000 },
    { 'category.name': 'Transport', amount: -30000 },
  ];
  const result = formatMonthlySummary(rows);
  assert.match(result, /Food/);
  assert.match(result, /45.000/);
  assert.doesNotMatch(result, /Salary/);
});

test('formatMonthlySummary: drops uncategorized rows and formats amounts as positive spend', () => {
  const rows: QueryRow[] = [
    { 'category.name': null, amount: -5000 },
    { 'category.name': 'Food', amount: -12000 },
  ];
  const result = formatMonthlySummary(rows);
  assert.match(result, /Food/);
  assert.match(result, /12.000/);
});

test('formatMonthlySummary: no categorized rows falls back to empty-state message', () => {
  const result = formatMonthlySummary([]);
  assert.equal(result, 'No categorized spending this month yet.');
});

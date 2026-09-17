import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTextTable } from './textTable.js';

test('aligns columns to the widest cell', () => {
  const table = renderTextTable(
    ['Category', 'Amount'],
    [
      ['Food', '45.000 ₫'],
      ['Groceries', '120.000 ₫'],
    ],
  );
  assert.equal(
    table,
    ['Category   Amount', '---------  ---------', 'Food       45.000 ₫', 'Groceries  120.000 ₫'].join('\n'),
  );
});

test('renders header and separator with no rows', () => {
  const table = renderTextTable(['A', 'B'], []);
  assert.equal(table, ['A  B', '-  -'].join('\n'));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatVnd, formatVndDelta } from './money.js';

test('formats whole VND amounts with vi-VN grouping, no minor-unit scaling', () => {
  assert.equal(formatVnd(45000), '45.000 ₫');
});

test('does not 100x-inflate a typical expense', () => {
  // Actual's minor unit for a zero-decimal currency IS the unit.
  // 45 000 VND must be stored/read as -45000, never -4500000.
  assert.equal(formatVnd(45000), '45.000 ₫');
  assert.notEqual(formatVnd(45000), formatVnd(4500000));
});

test('formats zero and negative amounts', () => {
  assert.equal(formatVnd(0), '0 ₫');
  assert.equal(formatVnd(-45000), '-45.000 ₫');
});

test('formats large amounts', () => {
  assert.equal(formatVnd(1500000), '1.500.000 ₫');
});

test('formatVndDelta signs a positive delta', () => {
  assert.equal(formatVndDelta(45000), '+45.000 ₫');
});

test('formatVndDelta signs a negative delta', () => {
  assert.equal(formatVndDelta(-45000), '-45.000 ₫');
});

test('formatVndDelta has no sign for zero', () => {
  assert.equal(formatVndDelta(0), '0 ₫');
});

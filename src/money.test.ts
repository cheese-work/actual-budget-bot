import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatVnd, formatVndDelta, parseAmountToMinorUnits } from './money.js';

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

// --- Regression: B3, grouped integers silently wrong or rejected ---

test('5,000,000 -> repeated US group separators parse as 5,000,000, not null', () => {
  assert.equal(parseAmountToMinorUnits('5,000,000'), 5_000_000);
});

test('5.000.000 -> repeated EU group separators parse as 5,000,000', () => {
  assert.equal(parseAmountToMinorUnits('5.000.000'), 5_000_000);
});

test('1,200 -> single comma followed by exactly 3 digits is a thousands group, not 1.2', () => {
  assert.equal(parseAmountToMinorUnits('1,200'), 1200);
});

test('1.200 -> single dot followed by exactly 3 digits is a thousands group, not 1.2', () => {
  assert.equal(parseAmountToMinorUnits('1.200'), 1200);
});

test('1,234.56 -> both separators present still resolves as US decimal (unchanged)', () => {
  assert.equal(parseAmountToMinorUnits('1,234.56'), 1235); // rounds to nearest dong
});

test('1.234,56 -> both separators present still resolves as EU decimal (unchanged)', () => {
  assert.equal(parseAmountToMinorUnits('1.234,56'), 1235);
});

test('4.50 -> single dot followed by 2 digits is still read as a decimal point', () => {
  assert.equal(parseAmountToMinorUnits('4.50'), 5); // rounds to nearest dong
});

test('4,5 -> single comma followed by 1 digit is still read as a decimal point', () => {
  assert.equal(parseAmountToMinorUnits('4,5'), 5); // rounds to nearest dong
});

test('-1,200 -> sign preserved through the thousands-group disambiguation', () => {
  assert.equal(parseAmountToMinorUnits('-1,200'), -1200);
});

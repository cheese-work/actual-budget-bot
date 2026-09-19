import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJevMinConfidence, parseJevTimeoutMs } from './config.js';

// `config` itself is a module-level singleton evaluated once at import time,
// so process.env can't be mutated and re-read through it. Test the exported
// parsing helpers directly instead -- fast, deterministic, no subprocess or
// cache-busting import needed.

test('parseJevMinConfidence: unset -> default, no warning needed', () => {
  assert.equal(parseJevMinConfidence(undefined), 0.85);
});

test('parseJevMinConfidence: non-numeric string -> default (fails closed, not NaN)', () => {
  assert.equal(parseJevMinConfidence('abc'), 0.85);
});

test('parseJevMinConfidence: set but empty -> default, not silently 0', () => {
  assert.equal(parseJevMinConfidence(''), 0.85);
});

test('parseJevMinConfidence: above valid range (5) -> default', () => {
  assert.equal(parseJevMinConfidence('5'), 0.85);
});

test('parseJevMinConfidence: below valid range (-1) -> default', () => {
  assert.equal(parseJevMinConfidence('-1'), 0.85);
});

test('parseJevMinConfidence: 1e999 (Infinity) -> default', () => {
  assert.equal(parseJevMinConfidence('1e999'), 0.85);
});

test('parseJevMinConfidence: valid 0.9 -> 0.9', () => {
  assert.equal(parseJevMinConfidence('0.9'), 0.9);
});

test('parseJevMinConfidence: explicit "0" is honoured -- distinct from unset/empty', () => {
  assert.equal(parseJevMinConfidence('0'), 0);
});

test('parseJevMinConfidence: boundary 1 is valid (inclusive range)', () => {
  assert.equal(parseJevMinConfidence('1'), 1);
});

test('parseJevTimeoutMs: unset -> default', () => {
  assert.equal(parseJevTimeoutMs(undefined), 1500);
});

test('parseJevTimeoutMs: non-numeric string -> default', () => {
  assert.equal(parseJevTimeoutMs('abc'), 1500);
});

test('parseJevTimeoutMs: set but empty -> default', () => {
  assert.equal(parseJevTimeoutMs(''), 1500);
});

test('parseJevTimeoutMs: zero -> default (must be strictly positive)', () => {
  assert.equal(parseJevTimeoutMs('0'), 1500);
});

test('parseJevTimeoutMs: negative -> default', () => {
  assert.equal(parseJevTimeoutMs('-5'), 1500);
});

test('parseJevTimeoutMs: above sanity ceiling -> default', () => {
  assert.equal(parseJevTimeoutMs('999999999'), 1500);
});

test('parseJevTimeoutMs: valid 800 -> 800', () => {
  assert.equal(parseJevTimeoutMs('800'), 800);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJevMinConfidence, parseJevTimeoutMs, parseSyncIntervalMs } from './config.js';

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

// CHANGED (review finding): "0" used to be honoured as a distinct, valid
// floor. It no longer is -- a floor of 0 isn't a floor (every confidence,
// including the model's own "0% confident", would clear it), and 0 is also
// the value that underflow ("1e-400"), "-0", and hex "0x0" all silently
// collapse to with no warning. The floor must now be strictly positive.
test('parseJevMinConfidence: explicit "0" is now rejected -- a floor of 0 floors nothing -> default', () => {
  assert.equal(parseJevMinConfidence('0'), 0.85);
});

test('parseJevMinConfidence: "-0" is rejected (same hole as "0", opposite sign) -> default', () => {
  assert.equal(parseJevMinConfidence('-0'), 0.85);
});

test('parseJevMinConfidence: "1e-400" underflows to 0 and is rejected -> default', () => {
  assert.equal(parseJevMinConfidence('1e-400'), 0.85);
});

test('parseJevMinConfidence: "0x0" coerces to 0 and is rejected -> default', () => {
  assert.equal(parseJevMinConfidence('0x0'), 0.85);
});

test('parseJevMinConfidence: boundary 1 is valid (inclusive range)', () => {
  assert.equal(parseJevMinConfidence('1'), 1);
});

test('parseJevMinConfidence: smallest normal positive float is valid (lower bound is exclusive of 0, not of "small")', () => {
  assert.equal(parseJevMinConfidence('0.0001'), 0.0001);
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

// Review finding: below the sanity floor is indistinguishable from "the
// feature is 100% dead" (every real call aborts before Jev's own compute
// finishes) with no operator-visible signal, since Jev-disabled and
// Jev-unreachable are deliberately unobservable from the outside.
test('parseJevTimeoutMs: below the 50ms sanity floor -> default', () => {
  assert.equal(parseJevTimeoutMs('16'), 1500);
});

test('parseJevTimeoutMs: exactly at the 50ms floor -> honoured', () => {
  assert.equal(parseJevTimeoutMs('50'), 50);
});

test('parseJevTimeoutMs: above the 5000ms ceiling -> default', () => {
  assert.equal(parseJevTimeoutMs('5001'), 1500);
});

test('parseJevTimeoutMs: exactly at the 5000ms ceiling -> honoured', () => {
  assert.equal(parseJevTimeoutMs('5000'), 5000);
});

test('parseJevTimeoutMs: previous 60s-ceiling value is now rejected (ceiling lowered) -> default', () => {
  assert.equal(parseJevTimeoutMs('60000'), 1500);
});

test('parseJevTimeoutMs: above sanity ceiling -> default', () => {
  assert.equal(parseJevTimeoutMs('999999999'), 1500);
});

test('parseJevTimeoutMs: valid 800 -> 800', () => {
  assert.equal(parseJevTimeoutMs('800'), 800);
});

test('parseJevTimeoutMs: surrounding whitespace still works -> 800', () => {
  assert.equal(parseJevTimeoutMs(' 800 '), 800);
});

// Review finding: `Number()` accepts far more than decimal integers, and
// `Number.isInteger` alone waves several of these through with no warning.
test('parseJevTimeoutMs: hex literal "0x10" -> default (not silently coerced to 16)', () => {
  assert.equal(parseJevTimeoutMs('0x10'), 1500);
});

test('parseJevTimeoutMs: binary literal "0b11" -> default (not silently coerced to 3)', () => {
  assert.equal(parseJevTimeoutMs('0b11'), 1500);
});

test('parseJevTimeoutMs: octal literal "0o17" -> default', () => {
  assert.equal(parseJevTimeoutMs('0o17'), 1500);
});

test('parseJevTimeoutMs: exponent notation "1e3" -> default (not silently coerced to 1000)', () => {
  assert.equal(parseJevTimeoutMs('1e3'), 1500);
});

// Regression for review finding: mutating Number.isInteger -> Number.isFinite
// leaves this guard toothless, because AbortSignal.timeout(1.5) throws
// "must be an integer" at call time -- a fractional value must never reach
// config.jevTimeoutMs.
test('parseJevTimeoutMs: fractional value "1.5" -> default (must be a whole number of ms)', () => {
  assert.equal(parseJevTimeoutMs('1.5'), 1500);
});

test('parseSyncIntervalMs: unset -> default (5 minutes)', () => {
  assert.equal(parseSyncIntervalMs(undefined), 5 * 60 * 1000);
});

test('parseSyncIntervalMs: non-numeric string -> default', () => {
  assert.equal(parseSyncIntervalMs('abc'), 5 * 60 * 1000);
});

// Review finding: SYNC_INTERVAL_MS="" (set-but-empty) is not nullish, so a
// bare `Number(process.env.X ?? default)` never falls back and instead
// evaluates Number('') === 0. setInterval(fn, 0) is coerced by Node to 1ms,
// turning a blank env var into an ~1000 req/s hammer against the sync
// endpoint with no in-flight guard.
test('parseSyncIntervalMs: set but empty -> default, not silently 0', () => {
  assert.equal(parseSyncIntervalMs(''), 5 * 60 * 1000);
});

test('parseSyncIntervalMs: "abc" -> default, not silently NaN', () => {
  assert.equal(parseSyncIntervalMs('abc'), 5 * 60 * 1000);
});

test('parseSyncIntervalMs: zero -> default (must be strictly positive and above the floor)', () => {
  assert.equal(parseSyncIntervalMs('0'), 5 * 60 * 1000);
});

test('parseSyncIntervalMs: negative -> default', () => {
  assert.equal(parseSyncIntervalMs('-5'), 5 * 60 * 1000);
});

test('parseSyncIntervalMs: below the 1000ms floor -> default', () => {
  assert.equal(parseSyncIntervalMs('999'), 5 * 60 * 1000);
});

test('parseSyncIntervalMs: exactly at the 1000ms floor -> honoured', () => {
  assert.equal(parseSyncIntervalMs('1000'), 1000);
});

test('parseSyncIntervalMs: above the 24h ceiling -> default', () => {
  assert.equal(parseSyncIntervalMs(String(24 * 60 * 60 * 1000 + 1)), 5 * 60 * 1000);
});

test('parseSyncIntervalMs: exactly at the 24h ceiling -> honoured', () => {
  assert.equal(parseSyncIntervalMs(String(24 * 60 * 60 * 1000)), 24 * 60 * 60 * 1000);
});

test('parseSyncIntervalMs: valid 300000 (the documented default) -> honoured', () => {
  assert.equal(parseSyncIntervalMs('300000'), 300000);
});

test('parseSyncIntervalMs: hex literal "0x10" -> default (not silently coerced to 16, which is also below the floor)', () => {
  assert.equal(parseSyncIntervalMs('0x10'), 5 * 60 * 1000);
});

test('parseSyncIntervalMs: fractional value "1000.5" -> default', () => {
  assert.equal(parseSyncIntervalMs('1000.5'), 5 * 60 * 1000);
});

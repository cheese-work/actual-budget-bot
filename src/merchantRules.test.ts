import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMerchant, merchantRules } from './merchantRules.js';

// --- normalizeMerchant ---

test('lowercases and collapses whitespace', () => {
  assert.equal(normalizeMerchant('  Grab   Food  '), 'grab food');
});

test("treats a card descriptor's '*' as a separator, not a truncation point", () => {
  assert.equal(normalizeMerchant('GRAB*FOOD 123'), 'grab food');
  assert.equal(normalizeMerchant('SHOPEE*PAY 99'), 'shopee pay');
});

test('strips a trailing #NNNN store number', () => {
  assert.equal(normalizeMerchant('Circle K #4412'), 'circle k');
});

test('strips a trailing bare store number', () => {
  assert.equal(normalizeMerchant('Techcombank 1234'), 'techcombank');
});

test('a raw card descriptor and the human-readable name share one key', () => {
  // The screenshot carries the POS descriptor ('GRAB*FOOD 123') while the
  // vision model reports 'Grab Food'. These MUST collide, or a rule learned
  // from one form never fires on the other and the repeat-merchant
  // no-model-call guarantee silently does nothing.
  assert.equal(normalizeMerchant('GRAB*FOOD 123'), normalizeMerchant('Grab Food'));
  assert.equal(normalizeMerchant('7-ELEVEN #221'), normalizeMerchant('7 Eleven'));
});

test('a rule learned from the descriptor form fires on the readable form', () => {
  merchantRules.clear();
  merchantRules.remember('GRAB*FOOD 123', 'cat-1', 'Food');
  assert.deepEqual(merchantRules.lookup('Grab Food'), {
    categoryId: 'cat-1',
    categoryName: 'Food',
  });
  merchantRules.clear();
});

test('empty/whitespace-only input normalizes to empty string', () => {
  assert.equal(normalizeMerchant('   '), '');
});

// --- MerchantRuleStore ---

test('remember + lookup round-trip', () => {
  merchantRules.clear();
  merchantRules.remember('Grab Food', 'cat-1', 'Food & Dining');
  const hit = merchantRules.lookup('Grab Food');
  assert.deepEqual(hit, { categoryId: 'cat-1', categoryName: 'Food & Dining' });
});

test('a differently-cased/punctuated repeat hits the same rule', () => {
  merchantRules.clear();
  merchantRules.remember('Circle K #1001', 'cat-1', 'Groceries');
  const hit = merchantRules.lookup('circle k #4412'); // same brand, different store number
  assert.deepEqual(hit, { categoryId: 'cat-1', categoryName: 'Groceries' });
});

test('lookup miss returns null', () => {
  merchantRules.clear();
  assert.equal(merchantRules.lookup('Unknown Merchant'), null);
});

test('size() reflects the number of learned rules', () => {
  merchantRules.clear();
  assert.equal(merchantRules.size(), 0);
  merchantRules.remember('Grab Food', 'cat-1', 'Food & Dining');
  merchantRules.remember('Circle K #4412', 'cat-2', 'Groceries');
  assert.equal(merchantRules.size(), 2);
});

test('remembering the same normalized merchant again overwrites, not duplicates', () => {
  merchantRules.clear();
  merchantRules.remember('Grab Food', 'cat-1', 'Food & Dining');
  merchantRules.remember('grab food', 'cat-2', 'Transport');
  assert.equal(merchantRules.size(), 1);
  assert.deepEqual(merchantRules.lookup('Grab Food'), {
    categoryId: 'cat-2',
    categoryName: 'Transport',
  });
});

test('clear() empties the store', () => {
  merchantRules.remember('Grab Food', 'cat-1', 'Food & Dining');
  merchantRules.clear();
  assert.equal(merchantRules.size(), 0);
  assert.equal(merchantRules.lookup('Grab Food'), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTransactionMessage } from './parse.js';

// Fixed reference date so 'today' / 'yesterday' / bare MM/DD are deterministic.
const TODAY = new Date(2026, 8, 17); // 2026-09-17

test('coffee 4.50 -> expense, payee, no tag/account/date (VND: rounds to nearest dong)', () => {
  const result = parseTransactionMessage('coffee 4.50', TODAY);
  assert.deepEqual(result, {
    amount: -5,
    payee: 'coffee',
    tag: null,
    accountKeyword: null,
    date: null,
  });
});

test('45k grab -> VND shorthand expense', () => {
  const result = parseTransactionMessage('45k grab', TODAY);
  assert.deepEqual(result, {
    amount: -45000,
    payee: 'grab',
    tag: null,
    accountKeyword: null,
    date: null,
  });
});

test('-120000 dinner #bali -> explicit negative amount with tag', () => {
  const result = parseTransactionMessage('-120000 dinner #bali', TODAY);
  assert.deepEqual(result, {
    amount: -120000,
    payee: 'dinner',
    tag: 'bali',
    accountKeyword: null,
    date: null,
  });
});

test('1tr rent -> triệu shorthand', () => {
  const result = parseTransactionMessage('1tr rent', TODAY);
  assert.equal(result?.amount, -1_000_000);
  assert.equal(result?.payee, 'rent');
});

test('1,234.56 groceries -> US grouped decimal, rounded to nearest dong', () => {
  const result = parseTransactionMessage('1,234.56 groceries', TODAY);
  assert.equal(result?.amount, -1235);
  assert.equal(result?.payee, 'groceries');
});

test('1.234,56 groceries -> EU grouped decimal, rounded to nearest dong', () => {
  const result = parseTransactionMessage('1.234,56 groceries', TODAY);
  assert.equal(result?.amount, -1235);
  assert.equal(result?.payee, 'groceries');
});

test('+500000 salary -> explicit plus makes it income; "salary" is an income keyword, stripped from payee', () => {
  const result = parseTransactionMessage('+500000 salary', TODAY);
  assert.deepEqual(result, {
    amount: 500000,
    payee: null,
    tag: null,
    accountKeyword: null,
    date: null,
  });
});

test('500000 income freelance -> income keyword makes it positive', () => {
  const result = parseTransactionMessage('500000 income freelance', TODAY);
  assert.equal(result?.amount, 500000);
  assert.equal(result?.payee, 'freelance');
});

test('coffee 4.50 acc:cash -> account keyword via acc: prefix', () => {
  const result = parseTransactionMessage('coffee 4.50 acc:cash', TODAY);
  assert.deepEqual(result, {
    amount: -5,
    payee: 'coffee',
    tag: null,
    accountKeyword: 'cash',
    date: null,
  });
});

test('coffee 4.50 @cash -> account keyword via @ prefix', () => {
  const result = parseTransactionMessage('coffee 4.50 @cash', TODAY);
  assert.equal(result?.accountKeyword, 'cash');
  assert.equal(result?.payee, 'coffee');
});

test('45k grab yesterday -> resolves relative date', () => {
  const result = parseTransactionMessage('45k grab yesterday', TODAY);
  assert.deepEqual(result, {
    amount: -45000,
    payee: 'grab',
    tag: null,
    accountKeyword: null,
    date: '2026-09-16',
  });
});

test('45k grab today -> resolves to reference date', () => {
  const result = parseTransactionMessage('45k grab today', TODAY);
  assert.equal(result?.date, '2026-09-17');
});

test('45k grab 12/3 -> MM/DD assumes current year', () => {
  const result = parseTransactionMessage('45k grab 12/3', TODAY);
  assert.equal(result?.date, '2026-12-03');
});

test('45k grab 12/3/2025 -> MM/DD/YYYY explicit year', () => {
  const result = parseTransactionMessage('45k grab 12/3/2025', TODAY);
  assert.equal(result?.date, '2025-12-03');
});

test('45k grab 2026-09-01 -> ISO date passthrough', () => {
  const result = parseTransactionMessage('45k grab 2026-09-01', TODAY);
  assert.equal(result?.date, '2026-09-01');
});

test('120000 dinner #bali acc:cash yesterday -> all fields combined', () => {
  const result = parseTransactionMessage('120000 dinner #bali acc:cash yesterday', TODAY);
  assert.deepEqual(result, {
    amount: -120000,
    payee: 'dinner',
    tag: 'bali',
    accountKeyword: 'cash',
    date: '2026-09-16',
  });
});

test('4.50 -> amount only, no payee (VND: rounds to nearest dong)', () => {
  const result = parseTransactionMessage('4.50', TODAY);
  assert.deepEqual(result, {
    amount: -5,
    payee: null,
    tag: null,
    accountKeyword: null,
    date: null,
  });
});

test('  45k   grab  -> extra whitespace is normalized', () => {
  const result = parseTransactionMessage('  45k   grab  ', TODAY);
  assert.equal(result?.amount, -45000);
  assert.equal(result?.payee, 'grab');
});

test('lunch with team #work 250k -> tag and amount in any order', () => {
  const result = parseTransactionMessage('lunch with team #work 250k', TODAY);
  assert.equal(result?.amount, -250000);
  assert.equal(result?.tag, 'work');
  assert.equal(result?.payee, 'lunch with team');
});

test('no amount at all -> returns null (must fall back)', () => {
  assert.equal(parseTransactionMessage('what did I spend on coffee this week', TODAY), null);
});

test('empty string -> returns null', () => {
  assert.equal(parseTransactionMessage('', TODAY), null);
  assert.equal(parseTransactionMessage('   ', TODAY), null);
});

test('99k xang xe -> Vietnamese payee text preserved', () => {
  const result = parseTransactionMessage('99k xang xe', TODAY);
  assert.equal(result?.amount, -99000);
  assert.equal(result?.payee, 'xang xe');
});

test('200k grab -> single candidate resolves normally', () => {
  const result = parseTransactionMessage('200k grab', TODAY);
  assert.equal(result?.amount, -200000);
});

// --- Regression: B1, sign inverted by the bare preposition 'in' ---

test("dinner in Hanoi 250k -> preposition 'in' must not flip sign to income", () => {
  const result = parseTransactionMessage('dinner in Hanoi 250k', TODAY);
  assert.equal(result?.amount, -250000);
});

test("lunch in Saigon 100k -> preposition 'in' must not flip sign to income", () => {
  const result = parseTransactionMessage('lunch in Saigon 100k', TODAY);
  assert.equal(result?.amount, -100000);
});

test("coffee in office 30k -> preposition 'in' must not flip sign to income", () => {
  const result = parseTransactionMessage('coffee in office 30k', TODAY);
  assert.equal(result?.amount, -30000);
});

test("spent 45k in grab -> preposition 'in' must not flip sign to income", () => {
  const result = parseTransactionMessage('spent 45k in grab', TODAY);
  assert.equal(result?.amount, -45000);
});

test("45k grab in cash -> preposition 'in' must not flip sign to income", () => {
  const result = parseTransactionMessage('45k grab in cash', TODAY);
  assert.equal(result?.amount, -45000);
});

test('income tax 200k -> explicit income keyword still flips sign (paying tax stays user-declared)', () => {
  const result = parseTransactionMessage('income tax 200k', TODAY);
  assert.equal(result?.amount, 200000);
});

test('salary 5tr -> unambiguous income keyword', () => {
  const result = parseTransactionMessage('salary 5tr', TODAY);
  assert.equal(result?.amount, 5_000_000);
});

test('got paid 5tr -> unambiguous income keyword', () => {
  const result = parseTransactionMessage('got paid 5tr', TODAY);
  assert.equal(result?.amount, 5_000_000);
});

// --- Regression: B2, first-number-wins swallowing the real amount ---

test('bought 2 coffees 90k -> suffixed amount wins over the bare quantity', () => {
  const result = parseTransactionMessage('bought 2 coffees 90k', TODAY);
  assert.equal(result?.amount, -90000);
});

test('2 beers 80k -> suffixed amount wins over the leading bare quantity', () => {
  const result = parseTransactionMessage('2 beers 80k', TODAY);
  assert.equal(result?.amount, -80000);
});

test('iphone 15 pro 30tr -> suffixed amount wins over the bare quantity', () => {
  const result = parseTransactionMessage('iphone 15 pro 30tr', TODAY);
  assert.equal(result?.amount, -30_000_000);
});

test('table for 4 500k -> suffixed amount wins over the bare quantity', () => {
  const result = parseTransactionMessage('table for 4 500k', TODAY);
  assert.equal(result?.amount, -500000);
});

test('two bare integers with nothing to rank them -> declines rather than guessing', () => {
  const result = parseTransactionMessage('table for 4 5', TODAY);
  assert.equal(result, null);
});

// --- Regression: N1, invalid dates silently rolled over instead of rejected ---

test('45k grab 2026-13-45 -> invalid ISO date is rejected, not passed through', () => {
  const result = parseTransactionMessage('45k grab 2026-13-45', TODAY);
  assert.equal(result?.date, null);
  assert.equal(result?.amount, -45000);
});

test('45k grab 02/31 -> invalid MM/DD is rejected, not rolled over to a real date', () => {
  const result = parseTransactionMessage('45k grab 02/31', TODAY);
  assert.equal(result?.date, null);
});

test('45k grab 99/99 -> wildly invalid MM/DD is rejected, rest of the message still parses', () => {
  const result = parseTransactionMessage('45k grab 99/99', TODAY);
  assert.equal(result?.date, null);
  assert.equal(result?.amount, -45000);
});

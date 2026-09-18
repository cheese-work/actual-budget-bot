import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ImageTransactionDeps } from './imageTransaction.js';
import type { VisionExtraction } from './visionExtract.js';

// config.ts validates required env vars at IMPORT time (throws if unset).
// imageTransaction.ts pulls in transactions.ts -> actualSession.ts ->
// config.ts transitively for resolveAccountId's type, so a static top-level
// import here would blow up before any test runs, in a process with no real
// Telegram/Actual credentials. Setting dummy values before a dynamic
// import() (NOT hoisted, unlike a static import) keeps this test hermetic
// without ever touching a real Telegram or Actual instance.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ACTUAL_SERVER_URL ??= 'http://127.0.0.1:5006';
process.env.ACTUAL_SYNC_ID ??= 'test-sync-id';

const { handleImageMessage } = await import('./imageTransaction.js');
const { transactionStore } = await import('./transactionStore.js');
const { merchantRules } = await import('./merchantRules.js');

const IMAGE = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' };

let messageCounter = 0;
/** Every call needs a fresh key — claimMessage() is a one-shot idempotency guard shared process-wide via transactionStore. */
function nextMessageKey(): string {
  messageCounter += 1;
  return `test-chat:${messageCounter}`;
}

function makeDeps(overrides: {
  vision?: VisionExtraction | null;
  accountId?: string | null;
  extractorCalls?: { count: number };
}): ImageTransactionDeps {
  const extractorCalls = overrides.extractorCalls ?? { count: 0 };
  return {
    extractor: async () => {
      extractorCalls.count += 1;
      return overrides.vision ?? null;
    },
    getAccounts: async () => [{ id: 'acc-1', name: 'Cash', closed: false } as never],
    getCategories: async () => [{ id: 'cat-1', name: 'Food & Dining' } as never],
    getPayees: async () => [],
    resolveAccountId: async () =>
      overrides.accountId === undefined ? 'acc-1' : overrides.accountId,
  };
}

test('caption amount 45000 beats a vision amount of 450', async () => {
  const deps = makeDeps({ vision: visionResult({ amount: 450, merchant: 'Some Shop' }) });
  const result = await handleImageMessage(1, IMAGE, '45000', nextMessageKey(), deps);
  assert.equal(result.kind, 'needsConfirmation');

  const pending = transactionStore.takePending(1);
  assert.equal(pending?.result.amount, -45000);
});

test('caption "45k dinner" beats vision -- amount -45000, payee dinner', async () => {
  const deps = makeDeps({ vision: visionResult({ amount: 9999, merchant: 'Wrong Merchant' }) });
  const result = await handleImageMessage(1, IMAGE, '45k dinner', nextMessageKey(), deps);
  assert.equal(result.kind, 'needsConfirmation');

  const pending = transactionStore.takePending(1);
  assert.equal(pending?.result.amount, -45000);
  assert.equal(pending?.result.payeeName, 'dinner');
});

test('no caption -> vision amount used as a negative expense', async () => {
  const deps = makeDeps({ vision: visionResult({ amount: 120000, merchant: 'Circle K' }) });
  const result = await handleImageMessage(1, IMAGE, null, nextMessageKey(), deps);
  assert.equal(result.kind, 'needsConfirmation');

  const pending = transactionStore.takePending(1);
  assert.equal(pending?.result.amount, -120000);
  assert.equal(pending?.result.payeeName, 'Circle K');
});

test('neither caption nor vision has an amount -> cannotExtract', async () => {
  const deps = makeDeps({ vision: visionResult({ amount: null, merchant: 'Circle K' }) });
  const result = await handleImageMessage(1, IMAGE, null, nextMessageKey(), deps);
  assert.deepEqual(result, { kind: 'cannotExtract' });
});

test('vision returning null entirely (transport/config failure) with no caption -> cannotExtract', async () => {
  const deps = makeDeps({ vision: null });
  const result = await handleImageMessage(1, IMAGE, null, nextMessageKey(), deps);
  assert.deepEqual(result, { kind: 'cannotExtract' });
});

test('a learned merchant rule is applied with no categorization model call', async () => {
  merchantRules.clear();
  merchantRules.remember('Circle K', 'cat-learned', 'Groceries');

  const extractorCalls = { count: 0 };
  const deps = makeDeps({
    vision: visionResult({ amount: 50000, merchant: 'Circle K' }),
    extractorCalls,
  });
  const result = await handleImageMessage(1, IMAGE, null, nextMessageKey(), deps);
  assert.equal(result.kind, 'needsConfirmation');
  // Exactly one extraction call for the transaction fields themselves --
  // the point of merchantRules is that no SECOND (categorization) call
  // happens on top of it.
  assert.equal(extractorCalls.count, 1);

  const pending = transactionStore.takePending(1);
  assert.equal(pending?.result.categoryName, 'Groceries');
});

test('the image path always returns needsConfirmation, never an auto-logged result -- even with a clean caption amount', async () => {
  const deps = makeDeps({ vision: visionResult({ amount: 45000, merchant: 'Circle K' }) });
  const result = await handleImageMessage(1, IMAGE, '45000 circle k', nextMessageKey(), deps);
  // ImageLogResult has no 'logged' variant at all (see imageTransaction.ts)
  // -- the type system itself guarantees this path can't auto-write.
  assert.equal(result.kind, 'needsConfirmation');
});

test('noAccount when no account resolves', async () => {
  const deps = makeDeps({
    vision: visionResult({ amount: 45000, merchant: 'Circle K' }),
    accountId: null,
  });
  const result = await handleImageMessage(1, IMAGE, null, nextMessageKey(), deps);
  assert.deepEqual(result, { kind: 'noAccount' });
});

test('duplicate messageKey is claimed once -- second call is a no-op', async () => {
  const key = nextMessageKey();
  const deps = makeDeps({ vision: visionResult({ amount: 45000, merchant: 'Circle K' }) });
  const first = await handleImageMessage(1, IMAGE, null, key, deps);
  assert.equal(first.kind, 'needsConfirmation');
  const second = await handleImageMessage(1, IMAGE, null, key, deps);
  assert.deepEqual(second, { kind: 'duplicate' });
});

function visionResult(fields: { amount: number | null; merchant: string | null }): VisionExtraction {
  return {
    amount: fields.amount,
    currency: 'VND',
    merchant: fields.merchant,
    date: null,
    sourceAccountHint: null,
    confidence: 'high',
  };
}

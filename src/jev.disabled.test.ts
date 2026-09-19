import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own process under `node --test` (see imageTransaction.test.ts for the same
// dynamic-import-after-env-set technique): config.ts is a singleton
// evaluated once per process, so this file's JEV_ENABLED=false can't
// coexist with jev.test.ts's JEV_ENABLED=true in one process.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ACTUAL_SERVER_URL ??= 'http://127.0.0.1:5006';
process.env.ACTUAL_SYNC_ID ??= 'test-sync-id';
process.env.JEV_ENABLED = 'false';
process.env.TYPESAFE_API_KEY = 'irrelevant-because-disabled';

const { ask } = await import('./jev.js');

test('JEV_ENABLED=false: ask() returns null without ever calling fetch', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('fetch must not be called when Jev is disabled');
  }) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await ask({
    text: 'did I spend 45k on coffee yesterday?',
    accountNames: [],
    categoryNames: [],
    today: '2026-09-19',
  });
  assert.equal(result, null);
});

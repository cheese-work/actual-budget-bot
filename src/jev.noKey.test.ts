import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own process (see jev.disabled.test.ts): JEV_ENABLED=true but
// TYPESAFE_API_KEY unset must degrade exactly like disabled -- never call
// out, never throw.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ACTUAL_SERVER_URL ??= 'http://127.0.0.1:5006';
process.env.ACTUAL_SYNC_ID ??= 'test-sync-id';
process.env.JEV_ENABLED = 'true';
process.env.TYPESAFE_API_KEY = '';

const { ask } = await import('./jev.js');

test('JEV_ENABLED=true, TYPESAFE_API_KEY unset: ask() returns null without ever calling fetch', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('fetch must not be called with no API key configured');
  }) as unknown as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await ask({
    text: 'was my grab spend over 200k this month',
    accountNames: [],
    categoryNames: [],
    today: '2026-09-19',
  });
  assert.equal(result, null);
});

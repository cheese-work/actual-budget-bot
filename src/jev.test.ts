import { test } from 'node:test';
import assert from 'node:assert/strict';

// Own process (see jev.disabled.test.ts / imageTransaction.test.ts for the
// same technique): JEV_ENABLED=true with a key configured, fixed for every
// test in this file. A short JEV_TIMEOUT_MS keeps the timeout test fast.
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.ACTUAL_SERVER_URL ??= 'http://127.0.0.1:5006';
process.env.ACTUAL_SYNC_ID ??= 'test-sync-id';
process.env.JEV_ENABLED = 'true';
process.env.TYPESAFE_API_KEY = 'test-key';
process.env.JEV_MIN_CONFIDENCE = '0.85';
process.env.JEV_TIMEOUT_MS = '50';

const { ask } = await import('./jev.js');

const CONTEXT = {
  text: 'did I spend 45k on coffee yesterday?',
  accountNames: ['Cash', 'Bank'],
  categoryNames: ['Food & Dining'],
  today: '2026-09-19',
};

function choiceResponse(choice: unknown, confidence: unknown): Response {
  return new Response(
    JSON.stringify({
      model: 'jev-latest',
      answers: { intent: { type: 'choice', choice, confidence, probabilities: {} } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function stubFetch(t: { after: (fn: () => void) => void }, impl: typeof fetch): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test('confident, valid response -> returns the chosen label', async (t) => {
  stubFetch(t, (async () => choiceResponse('spending_query', 0.97)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, 'spending_query');
});

test('sends a bearer token and the message text as state', async (t) => {
  let capturedInit: RequestInit | undefined;
  stubFetch(t, (async (_url, init) => {
    capturedInit = init;
    return choiceResponse('log_transaction', 0.95);
  }) as typeof fetch);

  await ask(CONTEXT);

  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('Authorization'), 'Bearer test-key');
  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.state.message, CONTEXT.text);
  assert.deepEqual(body.state.knownAccounts, CONTEXT.accountNames);
});

test('timeout -> null', async (t) => {
  // AbortSignal.timeout()'s internal timer is unref'd by design (so a real
  // ask() call never keeps a process alive on its own). In this isolated
  // test file that's the *only* pending work, so without a ref'd handle the
  // event loop can decide it's done and node:test cancels every remaining
  // test in the file before the abort ever fires. A short ref'd keep-alive
  // interval for the duration of this one test avoids that.
  const keepAlive = setInterval(() => {}, 10);
  t.after(() => clearInterval(keepAlive));

  stubFetch(t, ((_url, init) => {
    return new Promise((_resolve, reject) => {
      const signal = (init as RequestInit)?.signal;
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }) as typeof fetch);

  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('non-200 status -> null', async (t) => {
  stubFetch(t, (async () => new Response('nope', { status: 500 })) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('network error -> null', async (t) => {
  stubFetch(t, (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('malformed body (not JSON) -> null', async (t) => {
  stubFetch(t, (async () => new Response('not json', { status: 200 })) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('malformed body (missing answers) -> null', async (t) => {
  stubFetch(t, (async () => new Response(JSON.stringify({ model: 'jev-latest' }), { status: 200 })) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('confidence NaN -> null (not a valid JSON literal, but guards a non-conforming/extended parser)', async (t) => {
  stubFetch(t, (async () => choiceResponse('spending_query', NaN)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('confidence Infinity -> null', async (t) => {
  stubFetch(t, (async () => choiceResponse('spending_query', Infinity)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('confidence -Infinity -> null', async (t) => {
  stubFetch(t, (async () => choiceResponse('spending_query', -Infinity)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('confidence above 1 -> null', async (t) => {
  stubFetch(t, (async () => choiceResponse('spending_query', 1.4)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('confidence below 0 -> null', async (t) => {
  stubFetch(t, (async () => choiceResponse('spending_query', -0.1)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('oversized/precision-losing integer confidence -> null', async (t) => {
  // A 25-digit integer literal survives JSON.parse as a finite but wildly
  // out-of-range float (precision already lost) -- typeof alone would
  // accept it; the [0,1] range check must not.
  stubFetch(t, (async () => new Response(
    '{"model":"jev-latest","answers":{"intent":{"type":"choice","choice":"spending_query","confidence":9999999999999999999999999,"probabilities":{}}},"usage":{"input_tokens":1,"output_tokens":1}}',
    { status: 200 },
  )) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('unknown label -> null', async (t) => {
  stubFetch(t, (async () => choiceResponse('refund_request', 0.99)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('non-string label -> null', async (t) => {
  stubFetch(t, (async () => choiceResponse(42, 0.99)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('confidence below configured threshold -> null', async (t) => {
  stubFetch(t, (async () => choiceResponse('spending_query', 0.5)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('confidence exactly at configured threshold -> returns the label', async (t) => {
  stubFetch(t, (async () => choiceResponse('log_transaction', 0.85)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, 'log_transaction');
});

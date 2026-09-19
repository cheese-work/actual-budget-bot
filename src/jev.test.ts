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

const { ask, isValidConfidence } = await import('./jev.js');

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

// CHANGED (review finding): the NaN/Infinity/-Infinity variants of this test
// all transmitted the *same* wire payload -- `JSON.stringify` emits `null`
// for every one of them -- so all three were one test ("confidence: null ->
// null") wearing three names. Mutation-verified: deleting
// `Number.isFinite(value) &&` from isValidConfidence left all three green.
// Kept as a single, honestly-named end-to-end case; the NaN/Infinity/
// -Infinity distinction is covered directly below via isValidConfidence
// (which a raw-JSON round trip can't produce for NaN, since NaN has no JSON
// literal) and via a raw-JSON `1e999` case for Infinity specifically (JSON
// *does* have a literal that parses to Infinity).
test('confidence: null -> null', async (t) => {
  stubFetch(t, (async () => choiceResponse('spending_query', null)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('raw JSON "confidence":1e999 parses to Infinity -> null', async (t) => {
  stubFetch(t, (async () => new Response(
    '{"model":"jev-latest","answers":{"intent":{"type":"choice","choice":"spending_query","confidence":1e999,"probabilities":{}}},"usage":{"input_tokens":1,"output_tokens":1}}',
    { status: 200 },
  )) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('raw JSON "confidence":-1e999 parses to -Infinity -> null', async (t) => {
  stubFetch(t, (async () => new Response(
    '{"model":"jev-latest","answers":{"intent":{"type":"choice","choice":"spending_query","confidence":-1e999,"probabilities":{}}},"usage":{"input_tokens":1,"output_tokens":1}}',
    { status: 200 },
  )) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

// Direct unit tests on the exported pure predicate -- these isolate
// Number.isFinite and the [0,1] range independent of the confidence
// *threshold* (0.85 in this file), which any negative test value would
// also trip, masking whether the range check itself is doing anything (see
// the "below 0" case immediately below and its history).
test('isValidConfidence: NaN -> invalid', () => {
  assert.equal(isValidConfidence(NaN), false);
});

test('isValidConfidence: Infinity -> invalid', () => {
  assert.equal(isValidConfidence(Infinity), false);
});

test('isValidConfidence: -Infinity -> invalid', () => {
  assert.equal(isValidConfidence(-Infinity), false);
});

test('isValidConfidence: 0.5 -> valid', () => {
  assert.equal(isValidConfidence(0.5), true);
});

test('confidence above 1 -> null', async (t) => {
  stubFetch(t, (async () => choiceResponse('spending_query', 1.4)) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

// CHANGED (review finding): this used to call ask() end-to-end with
// confidence -0.1. That passed for the wrong reason -- mutation-verified,
// deleting `value >= 0 && value <= 1` from isValidConfidence left it green,
// because -0.1 is *also* below this file's fixed 0.85 threshold, so the
// separate threshold check masked the missing range check. Any negative
// value is unconditionally below any positive threshold, so there is no
// ask()-level input that can isolate the lower bound from the threshold in
// this file. Test the pure predicate directly instead, the same way
// config.ts's parse* helpers are tested directly rather than only through
// the values they gate.
test('isValidConfidence: -0.1 -> invalid (isolates the lower range bound, independent of the confidence threshold)', () => {
  assert.equal(isValidConfidence(-0.1), false);
});

test('isValidConfidence: 1.4 -> invalid (isolates the upper range bound)', () => {
  assert.equal(isValidConfidence(1.4), false);
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

// --- Finding 7: three untested crash-preventing guards in parseIntentAnswer ---
// Mutation-verified: deleting `body === null`, `answers === null`, or
// `answer === null` individually left the full suite green before this
// change. Each is a live crash -- e.g. with the `answer === null` guard
// removed, `{"answers":{"intent":null}}` throws
// "Cannot destructure property 'choice' of 'answer' as it is null."
// `null` (and, for the array-shaped variants, `[]`) is valid JSON at all
// three positions.
//
// A plain `assert.equal(result, null)` is NOT enough to fence these three
// specific guards, because `typeof null === 'object'` in JS: removing any
// one of them lets execution fall through into a property access on `null`,
// which throws -- and that throw is now caught by the Finding-1 try/catch
// one level up, which *also* resolves to null. Verified: mutating away
// `body === null` alone left this file's full suite green too, for exactly
// that reason -- the two layers of defense mask each other from a
// black-box return-value check. So these three tests additionally spy on
// the emitted log line and assert it's the explicit `jev_answer_rejected`
// (no `err` field) rather than the catch-all `jev_answer_rejected` with an
// `err` field, which only proves the *specific* guard fired, not merely
// that something upstream caught an exception.

function captureLoggedEvents(t: { after: (fn: () => void) => void }): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const originalLog = console.log;
  console.log = ((line: string) => {
    events.push(JSON.parse(line));
  }) as typeof console.log;
  t.after(() => {
    console.log = originalLog;
  });
  return events;
}

test('body: null -> null via the explicit guard, not the outer catch (regression)', async (t) => {
  const events = captureLoggedEvents(t);
  stubFetch(t, (async () => new Response('null', { status: 200 })) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
  const rejected = events.find((e) => e.event === 'jev_answer_rejected');
  assert.ok(rejected, 'expected a jev_answer_rejected log line');
  assert.equal('err' in rejected, false, 'guard should reject explicitly, not via the catch-all exception path');
});

test('body: [] -> null, does not throw', async (t) => {
  stubFetch(t, (async () => new Response('[]', { status: 200 })) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('answers: null -> null via the explicit guard, not the outer catch (regression)', async (t) => {
  const events = captureLoggedEvents(t);
  stubFetch(t, (async () => new Response(
    JSON.stringify({ model: 'jev-latest', answers: null }),
    { status: 200 },
  )) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
  const rejected = events.find((e) => e.event === 'jev_answer_rejected');
  assert.ok(rejected, 'expected a jev_answer_rejected log line');
  assert.equal('err' in rejected, false, 'guard should reject explicitly, not via the catch-all exception path');
});

test('answers: [] -> null, does not throw', async (t) => {
  stubFetch(t, (async () => new Response(
    JSON.stringify({ model: 'jev-latest', answers: [] }),
    { status: 200 },
  )) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('answers.intent: null -> null via the explicit guard, not the outer catch (regression)', async (t) => {
  const events = captureLoggedEvents(t);
  stubFetch(t, (async () => new Response(
    JSON.stringify({ model: 'jev-latest', answers: { intent: null } }),
    { status: 200 },
  )) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
  const rejected = events.find((e) => e.event === 'jev_answer_rejected');
  assert.ok(rejected, 'expected a jev_answer_rejected log line');
  assert.equal('err' in rejected, false, 'guard should reject explicitly, not via the catch-all exception path');
});

test('answers.intent: [] -> null, does not throw', async (t) => {
  stubFetch(t, (async () => new Response(
    JSON.stringify({ model: 'jev-latest', answers: { intent: [] } }),
    { status: 200 },
  )) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

// --- Finding 1 / Finding 2 regressions ---
// The old `logger.warn('jev_answer_rejected', { body: JSON.stringify(body)
// .slice(0, 500) })` sat outside every try/catch and serialized the whole
// body before truncating. JSON.stringify is recursive in V8 and blows the
// stack around depth ~5000 regardless of the eventual .slice(); JSON.parse
// itself is iterative and accepts far deeper nesting without complaint, so
// a 200 OK body with deeply nested unrelated content parsed fine and only
// crashed when the rejection path tried to log it. These build the nested
// structure as raw JSON text (not by constructing real nested JS values and
// then stringifying them), since doing that construction in the test itself
// would hit the very same stack limit before the code under test ever runs.

function deeplyNestedJsonArray(depth: number): string {
  return '['.repeat(depth) + '0' + ']'.repeat(depth);
}

test('deeply nested unrelated field alongside a below-threshold answer -> null, does not throw (regression)', async (t) => {
  const raw = `{"answers":{"intent":{"choice":"other","confidence":0.1}},"pad":${deeplyNestedJsonArray(6000)}}`;
  stubFetch(t, (async () => new Response(raw, { status: 200 })) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

test('deeply nested unrelated field alongside a malformed answer -> null, does not throw (regression)', async (t) => {
  const raw = `{"pad":${deeplyNestedJsonArray(6000)}}`;
  stubFetch(t, (async () => new Response(raw, { status: 200 })) as typeof fetch);
  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

// --- Finding 1: defense-in-depth try/catch around the parse+log region ---
// The two regression tests above prove the *root cause* (recursive
// JSON.stringify of the body) is gone -- summarizeBody() never serializes
// the body, so no legitimate JSON input reaches those tests' assertions via
// the try/catch at all. To prove the try/catch itself has teeth (per the
// review's explicit ask to make the whole region throw-safe against *any*
// future throw, not just this one), this forces a genuine exception inside
// the guarded region -- by making the only function it calls that isn't
// already exhaustively guarded (Object.keys, inside summarizeBody) throw --
// and asserts ask() still degrades to null instead of propagating it.
test('a throw inside the malformed-body summary path is still caught -> null (defense in depth)', async (t) => {
  stubFetch(t, (async () => new Response(
    JSON.stringify({ model: 'jev-latest' }), // missing `answers` -> malformed path
    { status: 200 },
  )) as typeof fetch);

  const originalKeys = Object.keys;
  Object.keys = () => {
    throw new Error('boom');
  };
  t.after(() => {
    Object.keys = originalKeys;
  });

  const result = await ask(CONTEXT);
  assert.equal(result, null);
});

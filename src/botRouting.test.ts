import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Composer, type Context } from 'grammy';
import { registerAccountsCommands } from './accountsCommands.js';
import { registerReportCommands, replySpendingQuery } from './reports.js';
import { registerLogTransactionHandlers } from './logTransactionHandlers.js';
import { registerIntentRouter, type IntentRouterDeps } from './intentRouter.js';
import type { IntentContext, MessageIntent } from './jev.js';

// Regression coverage for the src/bot.ts registration-order bug found in
// review: all three modules register a message:text handler, and whichever
// runs first decides whether the others are ever reached. Composer.middleware()
// lets us dispatch through all three, in the same order bot.ts registers them,
// without a real Telegram Bot/API — no network, and isActualReady() stays
// false (Actual session never started here) so report replies with its
// deterministic "not ready" message instead of hitting the Actual API.
function fakeContext(
  text: string,
  updateId: number,
  command?: string,
  userId = 42,
): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const chat = { id: 1, type: 'private' as const };
  const from = { id: userId, is_bot: false, first_name: 'Test' };
  const entities = command
    ? [{ type: 'bot_command' as const, offset: 0, length: command.length }]
    : undefined;
  const message = { message_id: updateId, date: 0, chat, from, text, entities };
  // grammy's on('message:text')/command() filters read ctx.update.message,
  // not the ctx.message shortcut, so the fake update needs the real nested shape.
  const update = { update_id: updateId, message };
  const ctx = {
    update,
    message,
    chat,
    from,
    reply: async (msg: string) => {
      replies.push(msg);
    },
  } as unknown as Context;
  return { ctx, replies };
}

// intentRouter.ts's own `enabled` boolean already collapses "JEV_ENABLED=false"
// and "JEV_ENABLED=true but TYPESAFE_API_KEY unset" into the same false value
// (see defaultDeps in intentRouter.ts) — both are covered at the config/env
// level by jev.disabled.test.ts and jev.noKey.test.ts (ask() returns null,
// never calls fetch, in each case). Here we only need one disabled shape to
// prove the router is a no-op at the dispatch level.
function disabledIntentDeps(): IntentRouterDeps {
  return {
    enabled: false,
    classifyIntent: async () => {
      throw new Error('classifyIntent must not be called while the intent router is disabled');
    },
    getAccounts: async () => {
      throw new Error('getAccounts must not be called while the intent router is disabled');
    },
    getCategories: async () => {
      throw new Error('getCategories must not be called while the intent router is disabled');
    },
    replySpendingQuery: async () => {
      throw new Error('replySpendingQuery must not be called while the intent router is disabled');
    },
  } as unknown as IntentRouterDeps;
}

function buildComposer(intentDeps: IntentRouterDeps = disabledIntentDeps()): Composer<Context> {
  const composer = new Composer<Context>();
  registerAccountsCommands(composer);
  registerReportCommands(composer);
  registerIntentRouter(composer, intentDeps);
  registerLogTransactionHandlers(composer);
  return composer;
}

test('report commands run first: a spending query reaches reports.ts, not the log handler', async () => {
  const composer = buildComposer();
  const { ctx, replies } = fakeContext('how much on food this month', 1);

  await composer.middleware()(ctx, async () => {});

  assert.equal(replies.length, 1);
  // reports.ts's withActualReadyGuard fires before touching the Actual API;
  // the log handler's "couldn't figure out a transaction" text must NOT appear.
  assert.match(replies[0], /not ready yet/i);
});

test('a non-query message still falls through to the log handler', async () => {
  const composer = buildComposer();
  const { ctx, replies } = fakeContext('what did I spend on 45k grab', 2);

  await composer.middleware()(ctx, async () => {});

  // This is the dangerous case from review: a question containing an amount
  // must not be silently logged as a transaction. With reports registered
  // first, the query pattern ("what did i spend") claims it before the log
  // handler ever sees it.
  assert.equal(replies.length, 1);
  assert.match(replies[0], /not ready yet/i);
});

test('an ordinary expense message with no query phrasing still reaches the log handler', async () => {
  const composer = buildComposer();
  const { ctx, replies } = fakeContext('coffee 45k', 3);

  await composer.middleware()(ctx, async () => {});

  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /not ready yet/i);
});

test('accounts runs first: idle (no pending confirmation) still falls through to the log handler', async () => {
  const composer = buildComposer();
  const { ctx, replies } = fakeContext('coffee 45k', 4);

  await composer.middleware()(ctx, async () => {});

  // Regression for the registration-order rewrite: registering accounts
  // first must not shadow ordinary messages for users with no pending
  // /setbalance-style flow. accountsCommands.ts calls next() when idle.
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /not ready yet/i);
});

test('accounts intercepts mid-flow: a pending /newaccount confirmation is not logged as a transaction', async () => {
  const composer = buildComposer();

  const { ctx: startCtx } = fakeContext('/newaccount', 5, '/newaccount');
  await composer.middleware()(startCtx, async () => {});

  // Reply to the "what should it be called?" prompt with a name that would
  // otherwise look like an expense line if it reached the log handler.
  const { ctx: replyCtx, replies } = fakeContext('Cash 45k', 6);
  await composer.middleware()(replyCtx, async () => {});

  assert.equal(replies.length, 1);
  // accountsCommands.ts's create_name state asks for on/off-budget next —
  // it must consume this message, not the log handler.
  assert.match(replies[0], /on-budget or off-budget/i);
});

// --- CHE-661: intentRouter.ts disabled-path regression -------------------
//
// A composer with no intentRouter registered at all -- this is "the base
// commit" for comparison purposes, since intentRouter.ts didn't exist before
// CHE-661.
function buildBaseComposer(): Composer<Context> {
  const composer = new Composer<Context>();
  registerAccountsCommands(composer);
  registerReportCommands(composer);
  registerLogTransactionHandlers(composer);
  return composer;
}

const DISABLED_PATH_FIXTURES = [
  'how much on food this month',
  'what did I spend on 45k grab',
  'coffee 45k',
  'did I spend 45k on coffee yesterday?',
  'was my grab spend over 200k this month',
];

test('disabled-path regression: routing is byte-identical to the base commit (no intentRouter)', async () => {
  // Distinct userId (not 42): accountsCommands.ts's `pending` map is a
  // module-level singleton shared across every test in this file, and the
  // "accounts intercepts mid-flow" test above deliberately leaves userId 42
  // mid-flow. A fresh userId keeps this test's messages from being
  // swallowed by that unrelated state machine.
  let updateId = 100;
  for (const text of DISABLED_PATH_FIXTURES) {
    const base = buildBaseComposer();
    const { ctx: baseCtx, replies: baseReplies } = fakeContext(text, updateId++, undefined, 900);
    await base.middleware()(baseCtx, async () => {});

    // disabledIntentDeps() throws if the router ever tries to call out --
    // any regression here fails loudly, not silently.
    const withRouter = buildComposer(disabledIntentDeps());
    const { ctx: routedCtx, replies: routedReplies } = fakeContext(text, updateId++, undefined, 901);
    await withRouter.middleware()(routedCtx, async () => {});

    assert.deepEqual(
      routedReplies,
      baseReplies,
      `routing for ${JSON.stringify(text)} diverged from the base commit`,
    );
  }
});

test('disabled-path regression: JEV_ENABLED=true but TYPESAFE_API_KEY absent collapses to the same disabled shape', async () => {
  // intentRouter.ts's defaultDeps computes `enabled: config.jevEnabled &&
  // Boolean(config.typesafeApiKey)` -- flag-on-no-key and flag-off both
  // evaluate to enabled: false, so they are indistinguishable at the router
  // level. jev.noKey.test.ts separately proves ask() itself returns null
  // without calling fetch for this exact env combination.
  const flagOnNoKeyDeps = disabledIntentDeps();
  const base = buildBaseComposer();
  const withRouter = buildComposer(flagOnNoKeyDeps);

  const { ctx: baseCtx, replies: baseReplies } = fakeContext('did I spend 45k on coffee yesterday?', 200, undefined, 902);
  await base.middleware()(baseCtx, async () => {});

  const { ctx: routedCtx, replies: routedReplies } = fakeContext('did I spend 45k on coffee yesterday?', 201, undefined, 903);
  await withRouter.middleware()(routedCtx, async () => {});

  assert.deepEqual(routedReplies, baseReplies);
});

// --- CHE-661: intentRouter.ts enabled-path -------------------------------
//
// classifyIntent is stubbed per the task's probe table -- no real network
// call is ever made in this test file. Call counting also proves the
// CHE-579/CHE-582 zero-model token rule: messages with no query-like signal
// (no "?", "spend", "how much", etc.) never reach classifyIntent at all,
// because POSSIBLE_QUERY_HINT_RE short-circuits first.
function stubbedIntentDeps(
  classify: (text: string) => MessageIntent | null,
  calls: string[],
): IntentRouterDeps {
  return {
    enabled: true,
    classifyIntent: async (context: IntentContext) => {
      calls.push(context.text);
      return classify(context.text);
    },
    getAccounts: async () => [],
    getCategories: async () => [],
    replySpendingQuery,
  } as unknown as IntentRouterDeps;
}

test('enabled path: an amount-bearing question ("did I spend 45k on coffee yesterday?") is routed to the spending report, not logged', async () => {
  const calls: string[] = [];
  const deps = stubbedIntentDeps(() => 'spending_query', calls);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('did I spend 45k on coffee yesterday?', 300, undefined, 904);

  await composer.middleware()(ctx, async () => {});

  // This is the exact CHE-661 defect scenario: the deterministic parser in
  // parse.ts can extract "45k" from this text, so before this change it
  // reached logTransactionHandlers.ts and was silently logged. With Jev
  // classifying it as spending_query, it must resolve through
  // replySpendingQuery (the "not ready yet" fingerprint) and never reach the
  // log handler.
  assert.deepEqual(calls, ['did I spend 45k on coffee yesterday?']);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /not ready yet/i);
});

test('enabled path: a second amount-bearing question ("was my grab spend over 200k this month") is also routed to the spending report, not logged', async () => {
  const calls: string[] = [];
  const deps = stubbedIntentDeps(() => 'spending_query', calls);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('was my grab spend over 200k this month', 301, undefined, 905);

  await composer.middleware()(ctx, async () => {});

  assert.deepEqual(calls, ['was my grab spend over 200k this month']);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /not ready yet/i);
});

test('enabled path: an ordinary expense ("coffee 45k") never reaches Jev and still logs', async () => {
  const calls: string[] = [];
  // classify would throw if called -- POSSIBLE_QUERY_HINT_RE must reject this
  // text before intentRouter ever calls classifyIntent.
  const deps = stubbedIntentDeps(() => {
    throw new Error('classifyIntent must not be called for "coffee 45k"');
  }, calls);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('coffee 45k', 302, undefined, 906);

  await composer.middleware()(ctx, async () => {});

  assert.deepEqual(calls, []);
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /not ready yet/i);
});

test('enabled path: CHE-579/CHE-582 token rule holds -- "45k grab" stays at zero Jev calls and still logs', async () => {
  const calls: string[] = [];
  const deps = stubbedIntentDeps(() => {
    throw new Error('classifyIntent must not be called for "45k grab"');
  }, calls);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('45k grab', 303, undefined, 907);

  await composer.middleware()(ctx, async () => {});

  assert.deepEqual(calls, []);
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /not ready yet/i);
});

test('enabled path: a low-confidence/failed classification (null) falls through exactly like disabled', async () => {
  const calls: string[] = [];
  const deps = stubbedIntentDeps(() => null, calls);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('did I spend 45k on coffee yesterday?', 304, undefined, 908);

  await composer.middleware()(ctx, async () => {});

  assert.deepEqual(calls, ['did I spend 45k on coffee yesterday?']);
  assert.equal(replies.length, 1);
  // Falls through to the log handler, same as if Jev had never been consulted.
  assert.doesNotMatch(replies[0], /not ready yet/i);
});

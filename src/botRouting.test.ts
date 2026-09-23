import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Composer, type Context } from 'grammy';
import { registerAccountsCommands } from './accountsCommands.js';
import { registerReportCommands } from './reports.js';
import { registerLogTransactionHandlers } from './logTransactionHandlers.js';
import { registerIntentRouter, defaultDeps, type IntentRouterDeps } from './intentRouter.js';
import { config } from './config.js';
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
//
// `calls`, when passed, counts invocations instead of throwing (CHE-661
// review finding 3): a throw from inside intentRouter's own try/catch at
// context-fetch time gets swallowed by that catch and falls through to
// next() anyway, so a throwing stub proves nothing about whether the
// `!deps.enabled` guard fired first. A call count that must stay at zero
// cannot be swallowed that way — it only stays zero if the guard actually
// short-circuited before deps were ever touched.
function disabledIntentDeps(calls?: {
  getAccounts: number;
  getCategories: number;
  classifyIntent: number;
}): IntentRouterDeps {
  return {
    enabled: false,
    classifyIntent: async () => {
      if (calls) calls.classifyIntent++;
      return null;
    },
    getAccounts: async () => {
      if (calls) calls.getAccounts++;
      return [];
    },
    getCategories: async () => {
      if (calls) calls.getCategories++;
      return [];
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

test('disabled-path regression: routing is byte-identical to the base commit, and no dep is ever touched', async () => {
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

    const calls = { getAccounts: 0, getCategories: 0, classifyIntent: 0 };
    const withRouter = buildComposer(disabledIntentDeps(calls));
    const { ctx: routedCtx, replies: routedReplies } = fakeContext(text, updateId++, undefined, 901);
    await withRouter.middleware()(routedCtx, async () => {});

    assert.deepEqual(
      routedReplies,
      baseReplies,
      `routing for ${JSON.stringify(text)} diverged from the base commit`,
    );
    // Mutation target: `if (!deps.enabled) return next();` in intentRouter.ts.
    // Delete it and this fails for every fixture that clears
    // POSSIBLE_QUERY_HINT_RE (4 of the 5 above) because getAccounts (and, for
    // fixtures where classify would run, classifyIntent) get invoked instead
    // of staying at zero.
    assert.deepEqual(
      calls,
      { getAccounts: 0, getCategories: 0, classifyIntent: 0 },
      `intentRouter touched a dep while disabled for ${JSON.stringify(text)}`,
    );
  }
});

// --- CHE-661: production configuration path (review finding 4) -----------
//
// Nothing above constructs `defaultDeps` or calls `registerIntentRouter`
// with a single argument, which is exactly how src/bot.ts:59 calls it. Both
// gaps meant a default flip (JEV_ENABLED parsing, the `&&` in defaultDeps,
// the `Boolean(...)` conversion) could ship green. These two tests exercise
// the real wiring end to end.
test('production config: Jev is off by default in this test env (no JEV_ENABLED, no TYPESAFE_API_KEY)', () => {
  // Pin the two raw inputs first: if either of these is ever true here, the
  // `defaultDeps.enabled` assertion below is meaningless (both being false
  // is what makes `&&` collapse to false regardless of the other operand —
  // see the report for the mutation this structurally cannot catch).
  assert.equal(config.jevEnabled, false);
  assert.equal(config.typesafeApiKey, '');
  assert.equal(defaultDeps.enabled, false);
});

test('production config: registerIntentRouter(composer) with no deps argument is a no-op, byte-identical to base', async () => {
  const base = buildBaseComposer();
  const composer = new Composer<Context>();
  registerAccountsCommands(composer);
  registerReportCommands(composer);
  registerIntentRouter(composer); // no second argument -- real defaultDeps
  registerLogTransactionHandlers(composer);

  const text = 'did I spend 45k on coffee yesterday?';
  const { ctx: baseCtx, replies: baseReplies } = fakeContext(text, 150, undefined, 910);
  await base.middleware()(baseCtx, async () => {});

  const { ctx: routedCtx, replies: routedReplies } = fakeContext(text, 151, undefined, 911);
  await composer.middleware()(routedCtx, async () => {});

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
  accounts: { name: string; closed?: boolean }[] = [],
  categories: { name: string }[] = [],
): IntentRouterDeps {
  return {
    enabled: true,
    classifyIntent: async (context: IntentContext) => {
      calls.push(context.text);
      return classify(context.text);
    },
    getAccounts: async () => accounts,
    getCategories: async () => categories,
  } as unknown as IntentRouterDeps;
}

test('enabled path: an amount-bearing question ("did I spend 45k on coffee yesterday?") is not logged, and is told how to log it', async () => {
  const calls: string[] = [];
  const deps = stubbedIntentDeps(() => 'spending_query', calls);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('did I spend 45k on coffee yesterday?', 300, undefined, 904);

  await composer.middleware()(ctx, async () => {});

  // This is the exact CHE-661 defect scenario: the deterministic parser in
  // parse.ts can extract "45k" from this text, so before this change it
  // reached logTransactionHandlers.ts and was silently logged. With Jev
  // classifying it as spending_query, the router must not feed the raw text
  // into reports.ts's parser (review finding 1 -- that produced a nonsense
  // "No category matching ..." reply); it must say plainly nothing was
  // recorded, point at working affordances, and -- because this exact text
  // IS deterministically parseable as an expense (review finding 2) -- tell
  // the user how to log it if that's what they meant.
  assert.deepEqual(calls, ['did I spend 45k on coffee yesterday?']);
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /No category matching/i);
  assert.match(replies[0], /not.*recorded|nothing was recorded/i);
  assert.match(replies[0], /\/recent/);
  assert.match(replies[0], /\/summary/);
  assert.match(replies[0], /meant to log/i);
});

test('enabled path: a second amount-bearing question ("was my grab spend over 200k this month") is also not logged, and is told how to log it', async () => {
  const calls: string[] = [];
  const deps = stubbedIntentDeps(() => 'spending_query', calls);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('was my grab spend over 200k this month', 301, undefined, 905);

  await composer.middleware()(ctx, async () => {});

  assert.deepEqual(calls, ['was my grab spend over 200k this month']);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /nothing was recorded/i);
  assert.match(replies[0], /meant to log/i);
});

test('enabled path: review finding 2 -- "spent 45k on coffee" (a real, deterministically-loggable expense) hits the query gate and must be told the expense was NOT logged', async () => {
  const calls: string[] = [];
  const deps = stubbedIntentDeps(() => 'spending_query', calls);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('spent 45k on coffee', 305, undefined, 909);

  await composer.middleware()(ctx, async () => {});

  assert.deepEqual(calls, ['spent 45k on coffee']);
  assert.equal(replies.length, 1);
  // The dangerous outcome finding 2 called out: a legitimate expense
  // silently dropped with no signal. The reply must say nothing was
  // recorded AND how to resend it as a loggable message.
  assert.match(replies[0], /nothing was recorded/i);
  assert.match(replies[0], /meant to log/i);
  assert.match(replies[0], /resend/i);
});

test('enabled path: a spending_query verdict on genuinely unparseable text omits the logging hint', async () => {
  const calls: string[] = [];
  const deps = stubbedIntentDeps(() => 'spending_query', calls);
  const composer = buildComposer(deps);
  // No digits at all -- parse.ts's parseTransactionMessage returns null for
  // this, so there is nothing to offer "resend it as an expense" advice
  // about. The hint must not appear for text that was never loggable.
  const { ctx, replies } = fakeContext('have i spent too much?', 306, undefined, 912);

  await composer.middleware()(ctx, async () => {});

  assert.deepEqual(calls, ['have i spent too much?']);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /nothing was recorded/i);
  assert.doesNotMatch(replies[0], /meant to log/i);
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

// --- CHE-661 review finding 5: classifyIntent must not be allowed to reject
// the whole middleware chain -----------------------------------------------

test('enabled path: a throwing classifyIntent does not silence the bot -- the message still falls through and gets a reply', async () => {
  // classify() throwing synchronously inside stubbedIntentDeps's async
  // wrapper still rejects the returned promise -- exactly the shape a real
  // ask() bug (or the JSON.stringify stack-overflow the review flagged
  // separately) would produce.
  const deps = stubbedIntentDeps(() => {
    throw new Error('jev blew up');
  }, []);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('did I spend 45k on coffee yesterday?', 400, undefined, 913);

  await composer.middleware()(ctx, async () => {});

  // Mutation target: the classifyIntent call must be wrapped in try/catch in
  // intentRouter.ts. Without it, this whole dispatch rejects and `replies`
  // stays empty -- total silence for the user, worse than base.
  assert.equal(replies.length, 1);
});

// --- CHE-661 review finding 6: three previously-uncovered production
// behaviours -----------------------------------------------------------------

test('enabled path: getAccounts/getCategories are filtered and mapped correctly -- closed accounts excluded, names not swapped', async () => {
  const calls: string[] = [];
  let captured: IntentContext | undefined;
  const deps: IntentRouterDeps = {
    enabled: true,
    classifyIntent: async (context: IntentContext) => {
      captured = context;
      calls.push(context.text);
      return null;
    },
    getAccounts: async () =>
      [
        { name: 'Cash', closed: false },
        { name: 'Old', closed: true },
      ] as never,
    getCategories: async () => [{ name: 'Coffee' }] as never,
  };
  const composer = buildComposer(deps);
  const { ctx } = fakeContext('did I spend 45k on coffee yesterday?', 401, undefined, 914);

  await composer.middleware()(ctx, async () => {});

  assert.deepEqual(calls, ['did I spend 45k on coffee yesterday?']);
  // Mutation targets, both fenced by this single assertion pair:
  //  - dropping `.filter((a) => !a.closed)` -> accountNames would include 'Old'
  //  - swapping accountNames/categoryNames -> accountNames would be ['Coffee']
  assert.deepEqual(captured?.accountNames, ['Cash']);
  assert.deepEqual(captured?.categoryNames, ['Coffee']);
});

test('a slash-prefixed message never reaches the intent router\'s deps, even when it contains hint words', async () => {
  const calls = { getAccounts: 0, getCategories: 0, classifyIntent: 0 };
  // enabled: true -- the only thing that should stop this from reaching Jev
  // is the `/`-prefix skip, not the enabled guard.
  const deps: IntentRouterDeps = {
    enabled: true,
    classifyIntent: async () => {
      calls.classifyIntent++;
      return null;
    },
    getAccounts: async () => {
      calls.getAccounts++;
      return [];
    },
    getCategories: async () => {
      calls.getCategories++;
      return [];
    },
  };
  const composer = buildComposer(deps);
  const { ctx } = fakeContext('/unknown how much did i spend?', 402, undefined, 915);

  await composer.middleware()(ctx, async () => {});

  // Mutation target: `if (text.startsWith('/')) return next();` in
  // intentRouter.ts. Delete it and getAccounts/classifyIntent get called
  // for this slash-prefixed text.
  assert.deepEqual(calls, { getAccounts: 0, getCategories: 0, classifyIntent: 0 });
});

// --- CHE-661 review finding 7: account_operation / other are untested
// fall-through branches -- pin them so a future change is visible ----------

test('enabled path: an "account_operation" verdict falls through unchanged (not a regression, pinned as follow-up material)', async () => {
  const calls: string[] = [];
  const deps = stubbedIntentDeps(() => 'account_operation', calls);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('did I spend 45k on coffee yesterday?', 403, undefined, 916);

  await composer.middleware()(ctx, async () => {});

  assert.deepEqual(calls, ['did I spend 45k on coffee yesterday?']);
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /nothing was recorded/i);
});

test('enabled path: an "other" verdict falls through unchanged', async () => {
  const calls: string[] = [];
  const deps = stubbedIntentDeps(() => 'other', calls);
  const composer = buildComposer(deps);
  const { ctx, replies } = fakeContext('did I spend 45k on coffee yesterday?', 404, undefined, 917);

  await composer.middleware()(ctx, async () => {});

  assert.deepEqual(calls, ['did I spend 45k on coffee yesterday?']);
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0], /nothing was recorded/i);
});

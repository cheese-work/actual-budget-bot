import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Composer, type Context } from 'grammy';
import { registerReportCommands } from './reports.js';
import { registerLogTransactionHandlers } from './logTransactionHandlers.js';

// Regression coverage for the src/bot.ts registration-order bug found in
// review: both modules register a message:text handler, and whichever runs
// first decides whether the other is ever reached. Composer.middleware()
// lets us dispatch through both, in the same order bot.ts registers them,
// without a real Telegram Bot/API — no network, and isActualReady() stays
// false (Actual session never started here) so report replies with its
// deterministic "not ready" message instead of hitting the Actual API.
function fakeContext(text: string, updateId: number): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const chat = { id: 1, type: 'private' as const };
  const from = { id: 42, is_bot: false, first_name: 'Test' };
  const message = { message_id: updateId, date: 0, chat, from, text };
  // grammy's on('message:text') filter reads ctx.update.message, not the
  // ctx.message shortcut, so the fake update needs the real nested shape.
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

function buildComposer(): Composer<Context> {
  const composer = new Composer<Context>();
  registerReportCommands(composer);
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

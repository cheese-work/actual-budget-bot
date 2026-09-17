import type { Bot } from 'grammy';
import { logger } from './logger.js';
import {
  cancelPendingTransaction,
  confirmPendingTransaction,
  handleTransactionMessage,
  undoLastTransaction,
} from './transactions.js';

const RESULT_MESSAGES = {
  cannotParse:
    "Couldn't figure out a transaction from that. Try e.g. `45k grab` or `coffee 4.50`.",
  noAccount: 'No account to log into yet — set one up first.',
  nothingToUndo: 'Nothing to undo.',
  undone: 'Last transaction removed.',
  noPending: 'No pending transaction to confirm.',
} as const;

/** Registers /yes, /no, /undo and the free-text transaction-logging handler. */
export function registerLogTransactionHandlers(bot: Bot): void {
  bot.command('yes', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const messageKey = `${ctx.chat.id}:${ctx.update.update_id}`;
    const outcome = await confirmPendingTransaction(userId, messageKey);
    if (outcome.kind === 'logged') {
      await ctx.reply(outcome.summary);
    } else {
      await ctx.reply(RESULT_MESSAGES.noPending);
    }
  });

  bot.command('no', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    const cancelled = cancelPendingTransaction(userId);
    await ctx.reply(cancelled ? 'Cancelled.' : RESULT_MESSAGES.noPending);
  });

  bot.command('undo', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    try {
      const outcome = await undoLastTransaction(userId);
      await ctx.reply(
        outcome.kind === 'undone' ? RESULT_MESSAGES.undone : RESULT_MESSAGES.nothingToUndo,
      );
    } catch (err) {
      logger.error('undo_failed', { err: String(err) });
      await ctx.reply('Undo failed — see logs.');
    }
  });

  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return next();

    const userId = ctx.from?.id;
    if (userId === undefined) return;

    const messageKey = `${ctx.chat.id}:${ctx.update.update_id}`;
    try {
      const result = await handleTransactionMessage(userId, text, messageKey);
      switch (result.kind) {
        case 'logged':
        case 'needsConfirmation':
          await ctx.reply(result.summary);
          break;
        case 'cannotParse':
          await ctx.reply(RESULT_MESSAGES.cannotParse);
          break;
        case 'noAccount':
          await ctx.reply(RESULT_MESSAGES.noAccount);
          break;
        case 'duplicate':
          // Already logged (or in flight) from the original delivery of this
          // update — stay silent rather than telling the user their
          // successfully-logged message "couldn't be figured out".
          break;
      }
    } catch (err) {
      logger.error('log_transaction_failed', { err: String(err) });
      await ctx.reply('Something went wrong logging that — see logs.');
    }
  });
}

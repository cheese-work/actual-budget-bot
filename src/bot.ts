import { Bot } from 'grammy';
import { config, isAllowedUser } from './config.js';
import { logger } from './logger.js';
import { getAccountCount, isActualReady } from './actualSession.js';
import { registerAccountsCommands } from './accountsCommands.js';
import { registerLogTransactionHandlers } from './logTransactionHandlers.js';
import { registerImageHandlers } from './imageHandlers.js';
import { registerReportCommands } from './reports.js';
import { registerIntentRouter } from './intentRouter.js';

export function createBot(): Bot {
  const bot = new Bot(config.telegramBotToken);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!isAllowedUser(userId)) {
      logger.warn('denied_user', { userId });
      return; // deny-by-default: no reply, no leak of bot presence details
    }
    return next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply('Bot is up. Try /help to see what I can do.');
  });

  bot.command('ping', async (ctx) => {
    if (!isActualReady()) {
      await ctx.reply('pong (Actual session not ready)');
      return;
    }
    try {
      const count = await getAccountCount();
      await ctx.reply(`pong — Actual reachable, ${count} account(s)`);
    } catch (err) {
      logger.error('ping_actual_check_failed', { err: String(err) });
      await ctx.reply('pong (Actual reachability check failed)');
    }
  });

  // Order matters: all four modules below register a message:text handler.
  // Accounts must run first — it only intercepts while a user is mid a
  // /setbalance-style confirmation flow, calling next() otherwise, so it
  // never shadows the rest. Reports runs next — its handler calls next()
  // for anything that doesn't match a spending-query pattern, falling
  // through cleanly. The Jev intent router runs next — for messages that
  // regex didn't already claim, it asks Jev (when enabled) whether the
  // message is actually a spending question in disguise (e.g. "did I spend
  // 45k on coffee yesterday?" parses as a loggable amount but is a
  // question); a `spending_query` verdict replies with the report and
  // stops here, before the write path ever sees it. Every other verdict —
  // including every Jev failure — falls through unchanged. The log handler
  // replies and stops on almost everything, so it must run last:
  // registering it earlier would make report queries unreachable (and
  // worse, a query that happens to contain an amount would get silently
  // logged as a transaction — the CHE-661 defect the intent router fixes).
  registerAccountsCommands(bot);
  registerReportCommands(bot);
  registerIntentRouter(bot);
  registerLogTransactionHandlers(bot);
  // Image handlers listen on message:photo / message:document only, so they
  // never compete with the message:text ordering above.
  registerImageHandlers(bot);

  bot.catch((err) => {
    logger.error('bot_error', { err: String(err.error), ctx: err.ctx.update.update_id });
  });

  return bot;
}

import { Bot } from 'grammy';
import { config, isAllowedUser } from './config.js';
import { logger } from './logger.js';
import { getAccountCount, isActualReady } from './actualSession.js';
import { registerLogTransactionHandlers } from './logTransactionHandlers.js';
import { registerReportCommands } from './reports.js';

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

  registerLogTransactionHandlers(bot);
  registerReportCommands(bot);

  bot.catch((err) => {
    logger.error('bot_error', { err: String(err.error), ctx: err.ctx.update.update_id });
  });

  return bot;
}

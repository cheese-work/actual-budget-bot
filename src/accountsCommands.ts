import { Composer, type Context } from 'grammy';
import { logger } from './logger.js';
import { formatVnd, formatVndDelta } from './money.js';
import {
  AdjustmentWriteFailedError,
  closeFundingSource,
  createFundingSource,
  getBalance,
  listAccounts,
  NonZeroBalanceError,
  reopenFundingSource,
  setBalance,
} from './accounts.js';

/**
 * Multi-step commands (create, set-balance, close/reopen) are driven by a
 * per-user pending state instead of a session plugin — each flow is a short
 * linear sequence and grammy ships no built-in conversation state.
 */
type PendingState =
  | { kind: 'create_name' }
  | { kind: 'create_offbudget'; name: string }
  | { kind: 'create_opening_balance'; name: string; offbudget: boolean }
  | { kind: 'set_balance_amount'; accountId: string; accountName: string }
  | { kind: 'set_balance_confirm'; accountId: string; accountName: string; statedBalance: number }
  | { kind: 'close_confirm'; accountId: string; accountName: string }
  | { kind: 'reopen_confirm'; accountId: string; accountName: string };

const pending = new Map<number, PendingState>();

function parseVndAmount(raw: string): number | undefined {
  const cleaned = raw.trim().replace(/[.,\s₫]/g, '');
  if (!/^-?\d+$/.test(cleaned)) return undefined;
  return Number(cleaned);
}

function parseYesNo(raw: string): boolean | undefined {
  const s = raw.trim().toLowerCase();
  if (['yes', 'y', 'on', 'onbudget', 'on-budget'].includes(s)) return true;
  if (['no', 'n', 'off', 'offbudget', 'off-budget'].includes(s)) return false;
  return undefined;
}

async function findAccountByName(name: string) {
  const accounts = await listAccounts();
  const needle = name.trim().toLowerCase();
  return accounts.find((a) => a.name.toLowerCase() === needle);
}

export function registerAccountsCommands(bot: Composer<Context>): void {
  bot.command('accounts', async (ctx) => {
    const accounts = await listAccounts();
    if (accounts.length === 0) {
      await ctx.reply('No funding sources yet. Use /newaccount to add one.');
      return;
    }
    const lines = await Promise.all(
      accounts.map(async (a) => {
        const balance = await getBalance(a.id);
        const status = a.closed ? ' (closed)' : '';
        return `${a.name}${status}: ${formatVnd(balance)}`;
      }),
    );
    await ctx.reply(lines.join('\n'));
  });

  bot.command('newaccount', async (ctx) => {
    pending.set(ctx.from!.id, { kind: 'create_name' });
    await ctx.reply('New funding source — what should it be called?');
  });

  bot.command('setbalance', async (ctx) => {
    const name = ctx.match?.toString().trim();
    if (!name) {
      await ctx.reply('Usage: /setbalance <account name>');
      return;
    }
    const account = await findAccountByName(name);
    if (!account) {
      await ctx.reply(`No funding source named "${name}". Check /accounts.`);
      return;
    }
    pending.set(ctx.from!.id, {
      kind: 'set_balance_amount',
      accountId: account.id,
      accountName: account.name,
    });
    await ctx.reply(`New balance for ${account.name}?`);
  });

  bot.command('closeaccount', async (ctx) => {
    const name = ctx.match?.toString().trim();
    if (!name) {
      await ctx.reply('Usage: /closeaccount <account name>');
      return;
    }
    const account = await findAccountByName(name);
    if (!account) {
      await ctx.reply(`No funding source named "${name}". Check /accounts.`);
      return;
    }
    pending.set(ctx.from!.id, {
      kind: 'close_confirm',
      accountId: account.id,
      accountName: account.name,
    });
    await ctx.reply(`Close ${account.name}? Reply yes to confirm.`);
  });

  bot.command('reopenaccount', async (ctx) => {
    const name = ctx.match?.toString().trim();
    if (!name) {
      await ctx.reply('Usage: /reopenaccount <account name>');
      return;
    }
    const account = await findAccountByName(name);
    if (!account) {
      await ctx.reply(`No funding source named "${name}". Check /accounts.`);
      return;
    }
    pending.set(ctx.from!.id, {
      kind: 'reopen_confirm',
      accountId: account.id,
      accountName: account.name,
    });
    await ctx.reply(`Reopen ${account.name}? Reply yes to confirm.`);
  });

  bot.on('message:text', async (ctx, next) => {
    const userId = ctx.from.id;
    const state = pending.get(userId);
    if (!state) {
      return next();
    }
    const text = ctx.message.text.trim();

    switch (state.kind) {
      case 'create_name': {
        pending.set(userId, { kind: 'create_offbudget', name: text });
        await ctx.reply('On-budget or off-budget? (on/off)');
        return;
      }
      case 'create_offbudget': {
        const offbudget = parseYesNo(text);
        if (offbudget === undefined) {
          await ctx.reply('Reply "on" or "off".');
          return;
        }
        pending.set(userId, {
          kind: 'create_opening_balance',
          name: state.name,
          offbudget,
        });
        await ctx.reply('Opening balance? Reply a VND amount, or "0" for none.');
        return;
      }
      case 'create_opening_balance': {
        const amount = parseVndAmount(text);
        if (amount === undefined) {
          await ctx.reply('Reply a VND amount, e.g. 500000, or "0".');
          return;
        }
        pending.delete(userId);
        const accountId = await createFundingSource({
          name: state.name,
          offbudget: state.offbudget,
          openingBalance: amount,
        });
        logger.info('account_created', { accountId, name: state.name });
        await ctx.reply(
          `Created "${state.name}" (${state.offbudget ? 'off-budget' : 'on-budget'}), opening balance ${formatVnd(amount)}.`,
        );
        return;
      }
      case 'set_balance_amount': {
        const statedBalance = parseVndAmount(text);
        if (statedBalance === undefined) {
          await ctx.reply('Reply a VND amount, e.g. 1500000.');
          return;
        }
        const current = await getBalance(state.accountId);
        const delta = statedBalance - current;
        if (delta === 0) {
          pending.delete(userId);
          await ctx.reply(`${state.accountName} is already at ${formatVnd(statedBalance)}. No change.`);
          return;
        }
        pending.set(userId, {
          kind: 'set_balance_confirm',
          accountId: state.accountId,
          accountName: state.accountName,
          statedBalance,
        });
        await ctx.reply(
          `${state.accountName}: ${formatVnd(current)} → ${formatVnd(statedBalance)} (${formatVndDelta(delta)}). Reply yes to write the adjustment.`,
        );
        return;
      }
      case 'set_balance_confirm': {
        if (text.toLowerCase() !== 'yes') {
          pending.delete(userId);
          await ctx.reply('Cancelled — no adjustment written.');
          return;
        }
        pending.delete(userId);
        let delta: number;
        try {
          delta = await setBalance(state.accountId, state.statedBalance);
        } catch (err) {
          if (err instanceof AdjustmentWriteFailedError) {
            logger.error('balance_adjustment_write_failed', { accountId: state.accountId });
            await ctx.reply(`Couldn't write the adjustment for ${state.accountName} — balance unchanged. Try again.`);
            return;
          }
          throw err;
        }
        logger.info('balance_adjusted', { accountId: state.accountId, delta });
        await ctx.reply(
          `${state.accountName} set to ${formatVnd(state.statedBalance)} (adjustment ${formatVndDelta(delta)}).`,
        );
        return;
      }
      case 'close_confirm': {
        if (text.toLowerCase() !== 'yes') {
          pending.delete(userId);
          await ctx.reply('Cancelled — account left open.');
          return;
        }
        pending.delete(userId);
        try {
          await closeFundingSource(state.accountId);
        } catch (err) {
          if (err instanceof NonZeroBalanceError) {
            await ctx.reply(`Can't close ${state.accountName}: ${err.message}`);
            return;
          }
          throw err;
        }
        logger.info('account_closed', { accountId: state.accountId });
        await ctx.reply(`${state.accountName} closed.`);
        return;
      }
      case 'reopen_confirm': {
        if (text.toLowerCase() !== 'yes') {
          pending.delete(userId);
          await ctx.reply('Cancelled — account left closed.');
          return;
        }
        pending.delete(userId);
        await reopenFundingSource(state.accountId);
        logger.info('account_reopened', { accountId: state.accountId });
        await ctx.reply(`${state.accountName} reopened.`);
        return;
      }
    }
  });
}

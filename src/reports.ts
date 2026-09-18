import * as actualApi from '@actual-app/api';
import type { Composer, Context } from 'grammy';
import { formatVnd } from './money.js';
import { renderTextTable } from './textTable.js';
import { parseSpendingQuery } from './spendingQuery.js';
import { logger } from './logger.js';
import { isActualReady } from './actualSession.js';

type QueryRow = Record<string, unknown>;

async function runAql(query: ReturnType<typeof actualApi.q>): Promise<QueryRow[]> {
  const result = (await actualApi.aqlQuery(query)) as { data: QueryRow[] };
  return result.data;
}

export async function getBalanceReport(): Promise<string> {
  const accounts = await actualApi.getAccounts();
  const openAccounts = accounts.filter((a) => !a.closed);

  if (openAccounts.length === 0) {
    return 'No accounts yet — the budget is empty.';
  }

  const balances = await Promise.all(
    openAccounts.map(async (account) => ({
      name: account.name,
      balance: await actualApi.getAccountBalance(account.id),
    })),
  );

  const total = balances.reduce((sum, b) => sum + b.balance, 0);
  const rows = balances.map((b) => [b.name, formatVnd(b.balance)]);
  const table = renderTextTable(['Account', 'Balance'], rows);

  return ['```', table, '```', '', `Total: ${formatVnd(total)}`].join('\n');
}

export async function getRecentTransactionsReport(limit: number): Promise<string> {
  const rows = await runAql(
    actualApi
      .q('transactions')
      .filter({ date: { $lte: new Date().toISOString().slice(0, 10) } })
      .select(['date', 'payee.name', 'category.name', 'amount'])
      .orderBy({ date: 'desc' })
      .limit(limit),
  );

  if (rows.length === 0) {
    return 'No transactions yet — the budget is empty.';
  }

  const tableRows = rows.map((r) => [
    String(r.date ?? ''),
    String(r['payee.name'] ?? '(no payee)'),
    String(r['category.name'] ?? '(uncategorized)'),
    formatVnd(Number(r.amount ?? 0)),
  ]);
  const table = renderTextTable(['Date', 'Payee', 'Category', 'Amount'], tableRows);

  return ['```', table, '```'].join('\n');
}

async function resolveCategoryName(candidate: string): Promise<string | undefined> {
  const categories = await actualApi.getCategories();
  const lowerCandidate = candidate.toLowerCase();
  const match = categories.find((c) => c.name.toLowerCase().includes(lowerCandidate));
  return match?.name;
}

export async function getSpendingQueryReport(text: string): Promise<string> {
  const { category: rawCategory, range } = parseSpendingQuery(text);

  const categoryName = rawCategory ? await resolveCategoryName(rawCategory) : undefined;
  if (rawCategory && !categoryName) {
    return `No category matching "${rawCategory}" found.`;
  }

  const filter: Record<string, unknown> = {
    date: { $gte: range.start, $lte: range.end },
  };
  if (categoryName) {
    filter['category.name'] = categoryName;
  }

  const rows = await runAql(
    actualApi
      .q('transactions')
      .filter(filter)
      .select({ total: { $sum: '$amount' } }),
  );

  const total = Number(rows[0]?.total ?? 0);
  const scope = categoryName ? `on ${categoryName}` : 'total';

  if (total === 0) {
    return `Nothing spent ${scope} for ${range.label}.`;
  }

  return `Spent ${scope} for ${range.label}: ${formatVnd(Math.abs(total))}`;
}

export async function getMonthlySummaryReport(): Promise<string> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const rows = await runAql(
    actualApi
      .q('transactions')
      .filter({ date: { $gte: start, $lte: end } })
      .groupBy('category.name')
      .orderBy({ 'category.name': 'asc' })
      .select(['category.name', { amount: { $sum: '$amount' } }]),
  );

  const categorized = rows.filter((r) => r['category.name'] != null);

  if (categorized.length === 0) {
    return 'No categorized spending this month yet.';
  }

  const tableRows = categorized.map((r) => [String(r['category.name']), formatVnd(Math.abs(Number(r.amount ?? 0)))]);
  const table = renderTextTable(['Category', 'Spent'], tableRows);

  return ['```', table, '```'].join('\n');
}

const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;
const SPENDING_QUERY_PATTERN = /how much|what did i spend|spending on/i;

const HELP_TEXT = [
  '*Reports*',
  '/balance — every open account plus total',
  '/recent [n] — last n transactions, default 10, max 50',
  '/summary — this month\'s spending by category',
  '',
  '*Ask a question*',
  'Just type it, no command needed:',
  '"how much on food this month?"',
  '"what did I spend yesterday?"',
  'Recognized time phrases: today, yesterday, this month, last month (defaults to this month).',
].join('\n');

function parseRecentLimit(arg: string | undefined): number {
  if (!arg) return DEFAULT_RECENT_LIMIT;
  const parsed = Number.parseInt(arg, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECENT_LIMIT;
  return Math.min(parsed, MAX_RECENT_LIMIT);
}

async function withActualReadyGuard(ctx: Context, run: () => Promise<string>): Promise<void> {
  if (!isActualReady()) {
    await ctx.reply('Actual session not ready yet — try again shortly.');
    return;
  }
  try {
    const text = await run();
    await ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('report_command_failed', { err: String(err) });
    await ctx.reply('Something went wrong fetching that report.');
  }
}

/** Registers the read-side report commands. Call once from bot.ts. */
export function registerReportCommands(bot: Composer<Context>): void {
  bot.command('help', async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' });
  });

  bot.command('balance', (ctx) => withActualReadyGuard(ctx, getBalanceReport));

  bot.command('recent', (ctx) => {
    const limit = parseRecentLimit(ctx.match?.toString().trim());
    return withActualReadyGuard(ctx, () => getRecentTransactionsReport(limit));
  });

  bot.command('summary', (ctx) => withActualReadyGuard(ctx, getMonthlySummaryReport));

  bot.on('message:text', (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith('/') || !SPENDING_QUERY_PATTERN.test(text)) {
      return next();
    }
    return withActualReadyGuard(ctx, () => getSpendingQueryReport(text));
  });
}

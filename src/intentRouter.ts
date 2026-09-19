import type { Composer, Context } from 'grammy';
import { config } from './config.js';
import { ask, type IntentContext, type MessageIntent } from './jev.js';
import { getAccounts, getCategories } from './actualSession.js';
import { replySpendingQuery } from './reports.js';
import { logger } from './logger.js';

/**
 * Cheap pre-filter deciding whether a message is worth asking Jev about at
 * all. reports.ts's SPENDING_QUERY_PATTERN already claims the obvious query
 * phrasings before this handler runs (registered after reports.ts in
 * bot.ts) — this only ever sees what that regex didn't match. A miss here
 * just falls through to today's behavior (never worse, only a missed
 * improvement); a false-positive spends one extra Jev call that resolves to
 * log_transaction/other and falls through anyway. This keeps unambiguous
 * inputs like "45k grab" at zero network calls (CHE-579/CHE-582 token
 * rule) instead of asking Jev about every single message.
 */
const POSSIBLE_QUERY_HINT_RE =
  /\?|\bspen[dt]\b|\bspending\b|\bhow much\b|\bhow many\b|\bdid i\b|\bwas my\b|\bhave i\b/i;

/**
 * Narrow injection seam for tests: Node's ESM live bindings aren't
 * configurable, so `node:test`'s `mock.method` cannot intercept a named
 * export across a module boundary (see imageTransaction.ts for the same
 * seam). `enabled` is captured once from config here rather than read
 * live, so a test can simulate "Jev enabled but classifyIntent always
 * fails" (e.g. no API key) without mutating the process-wide config
 * singleton.
 */
export type IntentRouterDeps = {
  enabled: boolean;
  classifyIntent: (context: IntentContext) => Promise<MessageIntent | null>;
  getAccounts: typeof getAccounts;
  getCategories: typeof getCategories;
  replySpendingQuery: typeof replySpendingQuery;
};

const defaultDeps: IntentRouterDeps = {
  enabled: config.jevEnabled && Boolean(config.typesafeApiKey),
  classifyIntent: ask,
  getAccounts,
  getCategories,
  replySpendingQuery,
};

function toIsoDateToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Registers the Jev typed-intent pre-gate for free-text messages. Must run
 * after reports.ts (so its regex still claims the obvious spending queries
 * for free) and before logTransactionHandlers.ts (so a `spending_query`
 * verdict can preempt the write path — the CHE-661 defect: a question
 * containing a parseable amount, e.g. "did I spend 45k on coffee
 * yesterday?", used to be silently logged as a real transaction).
 *
 * Only a `spending_query` verdict changes routing. Every other verdict —
 * including every Jev failure (disabled, unconfigured, timeout, non-200,
 * malformed body, unknown label, low confidence) — falls through via
 * `next()` to exactly today's deterministic-parse-then-log behavior. Jev
 * disabled and Jev unreachable are deliberately indistinguishable.
 */
export function registerIntentRouter(
  bot: Composer<Context>,
  deps: IntentRouterDeps = defaultDeps,
): void {
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return next();
    if (!deps.enabled) return next();
    if (!POSSIBLE_QUERY_HINT_RE.test(text)) return next();

    let accountNames: string[];
    let categoryNames: string[];
    try {
      const [accounts, categories] = await Promise.all([deps.getAccounts(), deps.getCategories()]);
      accountNames = accounts.filter((a) => !a.closed).map((a) => a.name);
      categoryNames = categories.map((c) => c.name);
    } catch (err) {
      logger.warn('intent_router_context_fetch_failed', { err: String(err) });
      return next();
    }

    const intent = await deps.classifyIntent({
      text,
      accountNames,
      categoryNames,
      today: toIsoDateToday(),
    });

    if (intent === 'spending_query') {
      return deps.replySpendingQuery(ctx, text);
    }
    return next();
  });
}

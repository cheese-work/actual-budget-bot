import type { Composer, Context } from 'grammy';
import { config } from './config.js';
import { ask, type IntentContext, type MessageIntent } from './jev.js';
import { getAccounts, getCategories } from './actualSession.js';
import { parseTransactionMessage } from './parse.js';
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
};

/**
 * Exported so tests can assert directly on the production wiring (is Jev
 * really off by default?) instead of only on hand-built stub deps — see
 * botRouting.test.ts's "production config" tests (CHE-661 review finding 4).
 */
export const defaultDeps: IntentRouterDeps = {
  enabled: config.jevEnabled && Boolean(config.typesafeApiKey),
  classifyIntent: ask,
  getAccounts,
  getCategories,
};

function toIsoDateToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// CHE-661 review finding 1: parseSpendingQuery's category extraction is
// tuned for reports.ts's own SPENDING_QUERY_PATTERN phrasings ("how much…",
// "what did i spend…"). Jev-routed text matches neither phrasing, so
// feeding it into that parser produces a nonsense "No category matching
// ... found" reply that leaks internal parser state. Don't guess a report
// here — reply with an honest, short disambiguation instead, pointing at
// the affordances that DO work.
const SPENDING_QUERY_HINTS =
  'Try /recent, /summary, or ask "how much on <category> this month?" / "what did I spend yesterday?".';

// Finding 2: a false-positive hint match on real, deterministically-parseable
// expense text (e.g. "spent 45k on coffee") must not silently drop the
// expense with no signal. When the same text would have been logged, say so.
const LOG_HINT_SUFFIX =
  ' If you meant to log an expense, resend it without the question wording, e.g. `45k coffee`.';

function buildSpendingQueryReply(text: string): string {
  const base = `Read that as a question, not an expense to log — nothing was recorded. ${SPENDING_QUERY_HINTS}`;
  return parseTransactionMessage(text) ? `${base}${LOG_HINT_SUFFIX}` : base;
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
 * disabled and Jev unreachable are deliberately indistinguishable in terms
 * of ROUTING OUTCOME only — not at the side-effect level (enabled-but-
 * unreachable still does the account/category fetch, still makes the
 * outbound Jev call, and still adds latency; see ENV_VARS.md's privacy
 * note for the full list).
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

    let intent: MessageIntent | null;
    try {
      intent = await deps.classifyIntent({
        text,
        accountNames,
        categoryNames,
        today: toIsoDateToday(),
      });
    } catch (err) {
      // Finding 5: classifyIntent is documented as "never throws" (jev.ts),
      // but that's a contract, not a guarantee — a defence-in-depth guard
      // belongs here regardless of whether the callee upholds it. Without
      // this, a throw here rejects the whole middleware chain: no log write,
      // no reply, total silence for the user (strictly worse than base).
      logger.warn('intent_router_classify_failed', { err: String(err) });
      return next();
    }

    if (intent === 'spending_query') {
      return ctx.reply(buildSpendingQueryReply(text));
    }
    return next();
  });
}

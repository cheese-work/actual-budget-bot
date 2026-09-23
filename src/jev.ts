import { config } from './config.js';
import { logger } from './logger.js';

/** The four buckets intentRouter.ts routes on. Bound and exhaustive — anything Jev returns outside this set is treated as a parse failure (null). */
export type MessageIntent = 'log_transaction' | 'spending_query' | 'account_operation' | 'other';

const INTENT_LABELS: readonly MessageIntent[] = [
  'log_transaction',
  'spending_query',
  'account_operation',
  'other',
];

export type IntentContext = {
  text: string;
  accountNames: string[];
  categoryNames: string[];
  today: string; // YYYY-MM-DD
};

const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const QUESTION_ID = 'intent';

/**
 * Classifies one inbound Telegram message into a fixed intent label via
 * TypeSafe AI's Jev ("System One") Choice primitive
 * (https://docs.typesafe.ai/concepts/system-one) — a typed, calibrated,
 * fast primitive over text state, ~70-500ms, text-only. Returns null on
 * EVERY failure path: disabled, unconfigured, timeout, non-200, network
 * error, malformed/unexpected body, unknown label, or confidence below
 * `config.jevMinConfidence` — callers must treat null exactly like "Jev
 * wasn't consulted" and fall back to existing behavior. Never throws.
 */
export async function ask(context: IntentContext): Promise<MessageIntent | null> {
  if (!config.jevEnabled) return null;
  if (!config.typesafeApiKey) return null;

  let response: Response;
  try {
    response = await fetch(SYSTEMONE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.typesafeApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildRequestBody(context)),
      signal: AbortSignal.timeout(config.jevTimeoutMs),
    });
  } catch (err) {
    // Covers both a timeout abort and a plain network failure — same
    // degrade either way.
    logger.warn('jev_request_failed', { err: String(err) });
    return null;
  }

  if (!response.ok) {
    logger.warn('jev_non_200', { status: response.status });
    // We never read this body — cancel it explicitly to document that the
    // stream is intentionally abandoned, not forgotten. Best-effort: some
    // Response implementations (e.g. already-consumed/null bodies in tests)
    // don't support cancel() or can throw synchronously.
    try {
      response.body?.cancel();
    } catch {
      // Nothing to do — we're discarding this response either way.
    }
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    logger.warn('jev_malformed_body', { err: String(err) });
    return null;
  }

  // The whole parse+log region must never throw: `ask()`'s contract is
  // "never throws" (see the doc comment above), and a caller like
  // intentRouter.ts awaits this with no try/catch of its own — an escaping
  // exception here drops the user's message entirely instead of degrading
  // to "Jev wasn't consulted". This wraps parseIntentAnswer (already
  // exception-free by construction — see its own guards) AND the logging
  // that follows it, as defense in depth against a future change to either.
  try {
    const parsed = parseIntentAnswer(body);
    switch (parsed.kind) {
      case 'ok':
        return parsed.intent;
      case 'low_confidence':
        // Routine, expected path (most answers land below a calibrated
        // 0.85+ floor) — log quietly, and only the validated label plus the
        // numeric confidence, never arbitrary server content.
        logger.info('jev_answer_below_threshold', {
          choice: parsed.choice,
          confidence: parsed.confidence,
        });
        return null;
      case 'malformed':
        // Genuinely unexpected shape — worth a warn, but never the full
        // body: see summarizeBody for why (unbounded size, unbounded
        // nesting depth, and potential echoed request content).
        logger.warn('jev_answer_rejected', summarizeBody(body));
        return null;
    }
  } catch (err) {
    logger.warn('jev_answer_rejected', { err: String(err) });
    return null;
  }
}

const MAX_SUMMARY_KEYS = 20;
const MAX_SUMMARY_STRING_LENGTH = 100;

/**
 * A bounded, non-recursive stand-in for logging the raw response body.
 * Deliberately never calls JSON.stringify(body): that call is recursive in
 * V8 and both (a) blows the stack on a body nested a few thousand levels
 * deep regardless of the eventual `.slice()`, and (b) fully materializes an
 * arbitrarily large body just to keep a short prefix, blocking the event
 * loop. `Object.keys` is shallow — it can't be made to recurse by nested
 * content — so this stays O(top-level key count) no matter what the server
 * sends. Also never echoes arbitrary response text (privacy: the API may
 * one day echo request `state` back, which would include raw message text
 * and account/category names).
 */
function summarizeBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    return { bodyType: typeof body };
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  const summary: Record<string, unknown> = {
    bodyKeys: keys.slice(0, MAX_SUMMARY_KEYS),
    bodyKeyCount: keys.length,
  };

  const answers = record.answers;
  if (typeof answers === 'object' && answers !== null) {
    const answer = (answers as Record<string, unknown>)[QUESTION_ID];
    if (typeof answer === 'object' && answer !== null) {
      const { choice, confidence } = answer as Record<string, unknown>;
      if (typeof choice === 'string') {
        summary.choice = choice.slice(0, MAX_SUMMARY_STRING_LENGTH);
      }
      if (typeof confidence === 'number') {
        summary.confidence = confidence;
      }
    }
  }

  return summary;
}

function buildRequestBody(context: IntentContext): unknown {
  return {
    state: {
      message: context.text,
      knownAccounts: context.accountNames,
      knownCategories: context.categoryNames,
      today: context.today,
    },
    model: MODEL,
    questions: {
      [QUESTION_ID]: {
        type: 'choice',
        instructions:
          'Classify the intent of this Telegram message sent to a personal budgeting bot.',
        criteria: {
          log_transaction:
            'States or implies a purchase, expense, or income to record. A statement, not a question.',
          spending_query:
            'Asks about past spending, balances, or budget totals. A question, not a statement to record.',
          account_operation:
            'Asks to create, close, reopen, or adjust a funding source/account.',
          other: 'None of the above — small talk, unclear, or unrelated text.',
        },
      },
    },
  };
}

/**
 * Strict response parsing. A prior review of the sibling Python client
 * (artemis#10) found a confidence-float parsing gap: `typeof x === 'number'`
 * alone accepts `NaN`/`Infinity`/out-of-range/imprecise-huge values that
 * `JSON.parse` can still hand back (a numeric literal like `1e999` parses to
 * `Infinity`, and an oversized integer literal silently loses precision
 * without becoming a different JS type). Guard with `Number.isFinite` plus
 * an explicit [0,1] range check, not just a `typeof` check.
 */
type ParseResult =
  | { kind: 'ok'; intent: MessageIntent }
  | { kind: 'low_confidence'; choice: MessageIntent; confidence: number }
  | { kind: 'malformed' };

function parseIntentAnswer(body: unknown): ParseResult {
  if (typeof body !== 'object' || body === null) return { kind: 'malformed' };

  const answers = (body as Record<string, unknown>).answers;
  if (typeof answers !== 'object' || answers === null) return { kind: 'malformed' };

  const answer = (answers as Record<string, unknown>)[QUESTION_ID];
  if (typeof answer !== 'object' || answer === null) return { kind: 'malformed' };

  const { choice, confidence } = answer as Record<string, unknown>;

  if (typeof choice !== 'string' || !isIntentLabel(choice)) return { kind: 'malformed' };
  if (!isValidConfidence(confidence)) return { kind: 'malformed' };
  if (confidence < config.jevMinConfidence) return { kind: 'low_confidence', choice, confidence };

  return { kind: 'ok', intent: choice };
}

function isIntentLabel(value: string): value is MessageIntent {
  return (INTENT_LABELS as readonly string[]).includes(value);
}

/** Exported for tests only — see jev.test.ts. */
export function isValidConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

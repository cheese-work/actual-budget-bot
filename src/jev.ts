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
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    logger.warn('jev_malformed_body', { err: String(err) });
    return null;
  }

  const intent = parseIntentAnswer(body);
  if (intent === null) {
    logger.warn('jev_answer_rejected', { body: JSON.stringify(body).slice(0, 500) });
  }
  return intent;
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
function parseIntentAnswer(body: unknown): MessageIntent | null {
  if (typeof body !== 'object' || body === null) return null;

  const answers = (body as Record<string, unknown>).answers;
  if (typeof answers !== 'object' || answers === null) return null;

  const answer = (answers as Record<string, unknown>)[QUESTION_ID];
  if (typeof answer !== 'object' || answer === null) return null;

  const { choice, confidence } = answer as Record<string, unknown>;

  if (typeof choice !== 'string' || !isIntentLabel(choice)) return null;
  if (!isValidConfidence(confidence)) return null;
  if (confidence < config.jevMinConfidence) return null;

  return choice;
}

function isIntentLabel(value: string): value is MessageIntent {
  return (INTENT_LABELS as readonly string[]).includes(value);
}

function isValidConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

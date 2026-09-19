import { logger } from './logger.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseAllowedUserIds(raw: string | undefined): ReadonlySet<number> {
  if (!raw || raw.trim() === '') {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s)),
  );
}

/**
 * Shared fail-closed parser for the Jev numeric knobs below. A malformed
 * `Number()` input (NaN, Infinity, out-of-range) must never silently widen
 * the gate it's supposed to constrain — see JEV_MIN_CONFIDENCE/JEV_TIMEOUT_MS
 * for the concrete failure modes this guards against. An unset var is the
 * normal default path and doesn't warn; a *set* var (including a set-but-
 * empty one — see ENV_VARS.md's own `TYPESAFE_API_KEY=` style) that fails
 * validation is a real misconfiguration and does.
 */
function parseBoundedNumber(
  name: string,
  raw: string | undefined,
  fallback: number,
  isValid: (value: number) => boolean,
): number {
  if (raw === undefined) {
    return fallback;
  }
  // Reject "set but empty" before Number() ever sees it: Number('') is 0,
  // which would otherwise be silently accepted as a real value whenever 0
  // happens to be in range (e.g. confidence).
  const value = raw.trim() === '' ? NaN : Number(raw);
  if (isValid(value)) {
    return value;
  }
  logger.warn('config_value_rejected', { name, raw, fallback });
  return fallback;
}

const JEV_MIN_CONFIDENCE_DEFAULT = 0.85;
const JEV_TIMEOUT_MS_DEFAULT = 1500;
// Generous sanity ceiling — well above any real network timeout — so a
// fat-fingered value (e.g. an accidental extra digit) degrades to the
// default instead of hanging the request for minutes.
const JEV_TIMEOUT_MS_MAX = 60_000;

/** Exported for tests only — see config.test.ts. */
export function parseJevMinConfidence(
  raw: string | undefined,
  fallback: number = JEV_MIN_CONFIDENCE_DEFAULT,
): number {
  return parseBoundedNumber(
    'JEV_MIN_CONFIDENCE',
    raw,
    fallback,
    (value) => Number.isFinite(value) && value >= 0 && value <= 1,
  );
}

/** Exported for tests only — see config.test.ts. */
export function parseJevTimeoutMs(
  raw: string | undefined,
  fallback: number = JEV_TIMEOUT_MS_DEFAULT,
): number {
  return parseBoundedNumber(
    'JEV_TIMEOUT_MS',
    raw,
    fallback,
    (value) => Number.isInteger(value) && value > 0 && value <= JEV_TIMEOUT_MS_MAX,
  );
}

export const config = {
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  actualServerUrl: required('ACTUAL_SERVER_URL'),
  actualSyncId: required('ACTUAL_SYNC_ID'),
  actualPassword: process.env.ACTUAL_PASSWORD ?? '',
  // End-to-end encrypted budget files need their own password, separate from the
  // server password. Empty means the file is not encrypted.
  actualFilePassword: process.env.ACTUAL_FILE_PASSWORD ?? '',
  actualDataDir: process.env.ACTUAL_DATA_DIR ?? '/data/actual-cache',
  allowedTelegramUserIds: parseAllowedUserIds(process.env.ALLOWED_TELEGRAM_USER_IDS),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS ?? 5 * 60 * 1000),
  // Only required for the free-text transaction fallback path (ambiguous
  // messages the deterministic parser can't handle). Absent when unset;
  // that path degrades to "please rephrase" instead of throwing.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
  // OmniRoute is an Anthropic-API-compatible proxy: setting a base URL and
  // auth token routes both the text-fallback and vision lanes through it
  // instead of hitting the vendor API directly with anthropicApiKey.
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? '',
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN ?? '',
  anthropicVisionModel: process.env.ANTHROPIC_VISION_MODEL ?? 'claude-haiku-4-5-20251001',
  // Jev ("System One" from TypeSafe AI) is an optional typed-intent pre-gate
  // for inbound text messages — off by default. Absent when unset; the
  // router degrades to today's regex-and-ordering behavior instead of
  // throwing. See ENV_VARS.md for the privacy note before enabling.
  jevEnabled: process.env.JEV_ENABLED === 'true',
  typesafeApiKey: process.env.TYPESAFE_API_KEY ?? '',
  // Population-calibrated confidence floor below which a Jev answer is
  // discarded (treated as null) rather than acted on. See jev.ts. Fails
  // closed to the default on anything malformed/out-of-range — see
  // parseJevMinConfidence.
  jevMinConfidence: parseJevMinConfidence(process.env.JEV_MIN_CONFIDENCE),
  jevTimeoutMs: parseJevTimeoutMs(process.env.JEV_TIMEOUT_MS),
};

export function isAllowedUser(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  // Deny-by-default: empty allowlist means nobody is allowed.
  return config.allowedTelegramUserIds.has(userId);
}

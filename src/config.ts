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
};

export function isAllowedUser(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  // Deny-by-default: empty allowlist means nobody is allowed.
  return config.allowedTelegramUserIds.has(userId);
}

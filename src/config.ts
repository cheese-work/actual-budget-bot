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
  actualDataDir: process.env.ACTUAL_DATA_DIR ?? '/data/actual-cache',
  allowedTelegramUserIds: parseAllowedUserIds(process.env.ALLOWED_TELEGRAM_USER_IDS),
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS ?? 5 * 60 * 1000),
};

export function isAllowedUser(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  // Deny-by-default: empty allowlist means nobody is allowed.
  return config.allowedTelegramUserIds.has(userId);
}

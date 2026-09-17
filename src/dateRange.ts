export type DateRange = { start: string; end: string; label: string };

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/**
 * Resolves the small set of relative-date phrases the spending-query
 * command supports. Returns undefined for anything it doesn't recognize —
 * callers fall back to "this month" or report the phrase as unsupported.
 */
export function resolveDateRange(phrase: string, now: Date = new Date()): DateRange | undefined {
  const normalized = phrase.trim().toLowerCase();

  if (normalized === '' || normalized === 'this month') {
    const start = startOfMonth(now);
    const end = endOfMonth(now);
    return { start: toIsoDate(start), end: toIsoDate(end), label: 'this month' };
  }

  if (normalized === 'today') {
    const today = toIsoDate(now);
    return { start: today, end: today, label: 'today' };
  }

  if (normalized === 'yesterday') {
    const yesterday = toIsoDate(addDays(now, -1));
    return { start: yesterday, end: yesterday, label: 'yesterday' };
  }

  if (normalized === 'last month') {
    const lastMonthAnchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const start = startOfMonth(lastMonthAnchor);
    const end = endOfMonth(lastMonthAnchor);
    return { start: toIsoDate(start), end: toIsoDate(end), label: 'last month' };
  }

  return undefined;
}

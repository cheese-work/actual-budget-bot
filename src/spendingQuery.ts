import { resolveDateRange, type DateRange } from './dateRange.js';

export type ParsedSpendingQuery = {
  category?: string;
  range: DateRange;
};

const DATE_PHRASES = ['this month', 'last month', 'yesterday', 'today'];

/**
 * Extracts a category keyword and a date range from a loosely-formed
 * spending question ("how much on food this month?", "what did I spend
 * yesterday?"). Only recognizes the fixed set of relative date phrases in
 * dateRange.ts — anything else defaults to "this month". The category, if
 * present, is matched case-insensitively against real category names by
 * the caller; this function only extracts the candidate phrase.
 */
export function parseSpendingQuery(text: string, now: Date = new Date()): ParsedSpendingQuery {
  const lower = text.toLowerCase().replace(/[?.!]/g, ' ').trim();

  let datePhrase = '';
  for (const phrase of DATE_PHRASES) {
    if (lower.includes(phrase)) {
      datePhrase = phrase;
      break;
    }
  }
  const range = resolveDateRange(datePhrase, now) ?? resolveDateRange('this month', now)!;

  let withoutDate = datePhrase ? lower.replace(datePhrase, ' ') : lower;
  withoutDate = withoutDate
    .replace(/^how much( (did|have) i)?\s*/, '')
    .replace(/^what did i spend\s*/, '')
    .replace(/\bspen[dt]\b/g, ' ')
    .replace(/\bspending\b/g, ' ')
    .replace(/\bon\b/g, ' ')
    .replace(/\b(for|in)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const category = withoutDate.length > 0 ? withoutDate : undefined;

  return { category, range };
}

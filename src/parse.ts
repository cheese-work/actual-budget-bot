import { parseAmountToMinorUnits } from './money.js';

export type ParsedTransaction = {
  /** Minor units, signed. Negative = expense (default), positive = income. */
  amount: number;
  payee: string | null;
  tag: string | null;
  accountKeyword: string | null;
  /** YYYY-MM-DD, or null to default to today at write time. */
  date: string | null;
};

const TAG_RE = /#(\S+)/;
// account keyword: 'acc:<word>' or '@<word>' (distinct from '#tag').
const ACCOUNT_RE = /(?:^|\s)(?:acc:|@)(\S+)/i;
const DATE_TOKEN_RE =
  /\b(today|yesterday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/i;
// Unambiguous income signals only. Excludes bare 'in' (a preposition, not a
// signal) — see the amount-sign comment below for why that mattered. Also
// excludes bare 'paid': "paid X" is the single most common way to phrase an
// EXPENSE ('paid rent 5tr', 'paid grab 45k'), so only the receiving-verb
// phrasing ('got paid', 'paid me') counts as an income signal — bare 'paid'
// does not. Two separate regex objects (same pattern) because a shared
// 'g'-flagged regex would carry lastIndex state between the .test() below
// and this module's .replace() call, corrupting matches on the second parse
// of a process.
const INCOME_KEYWORD_TEST_RE = /\b(income|salary|payday|refund|got paid|paid me)\b/i;
const INCOME_KEYWORD_REPLACE_RE = /\b(income|salary|payday|refund|got paid|paid me)\b/gi;

/**
 * Deterministic parse of a free-text transaction message. Returns null when
 * the message has no recognizable amount — callers should fall back to the
 * LLM path in that case. This function must never make a network call.
 */
export function parseTransactionMessage(
  text: string,
  today: Date = new Date(),
): ParsedTransaction | null {
  let remaining = text.trim();
  if (!remaining) return null;

  const tagMatch = remaining.match(TAG_RE);
  const tag = tagMatch ? tagMatch[1] : null;
  if (tagMatch) remaining = removeMatch(remaining, tagMatch);

  const accountMatch = remaining.match(ACCOUNT_RE);
  const accountKeyword = accountMatch ? accountMatch[1] : null;
  if (accountMatch) remaining = removeMatch(remaining, accountMatch);

  const dateMatch = remaining.match(DATE_TOKEN_RE);
  const date = dateMatch ? resolveDateToken(dateMatch[1], today) : null;
  if (dateMatch) remaining = removeMatch(remaining, dateMatch);

  const amountMatch = findAmountToken(remaining);
  if (!amountMatch) return null;

  const minorUnits = parseAmountToMinorUnits(amountMatch.token);
  if (minorUnits === null) return null;

  // Default sign: a bare amount is an expense (negative). An explicit '+' or
  // an unambiguous income keyword flips it positive. An explicit '-' stays
  // negative. Deliberately excludes bare 'in' — it's a common preposition
  // ('dinner in Hanoi'), not an income signal, and inverting on it silently
  // wrote expenses as income.
  const hasExplicitSign = amountMatch.token.trim().startsWith('-') || amountMatch.hadPlus;
  const isIncome = amountMatch.hadPlus || INCOME_KEYWORD_TEST_RE.test(remaining);
  const amount = hasExplicitSign
    ? minorUnits
    : isIncome
      ? Math.abs(minorUnits)
      : -Math.abs(minorUnits);

  remaining = (remaining.slice(0, amountMatch.start) + remaining.slice(amountMatch.end))
    .replace(INCOME_KEYWORD_REPLACE_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const payee = remaining.length > 0 ? remaining : null;

  return { amount, payee, tag, accountKeyword, date };
}

function removeMatch(text: string, match: RegExpMatchArray): string {
  const index = match.index ?? text.indexOf(match[0]);
  return (text.slice(0, index) + text.slice(index + match[0].length))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

type AmountToken = { token: string; start: number; end: number; hadPlus: boolean };

/**
 * Finds the amount token among all standalone number-like tokens in the
 * message, e.g. '45k', '1,234.56', '4.50'. A bare small integer next to a
 * suffixed or decimal-grouped token is usually a quantity ('2 coffees 90k'),
 * not the amount, so a suffixed/grouped candidate always wins over a bare
 * one regardless of position. When more than one bare-integer candidate
 * remains and none is marked, position alone can't disambiguate — return
 * null so the caller falls back to the LLM instead of guessing.
 */
function findAmountToken(text: string): AmountToken | null {
  const re = /([+-])?(\d[\d.,]*)\s*(k|tr)?\b/gi;
  const candidates: AmountToken[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const sign = match[1] ?? '';
    const digits = match[2];
    const suffix = match[3] ?? '';
    if (!/\d/.test(digits)) continue;
    candidates.push({
      token: `${sign === '-' ? '-' : ''}${digits}${suffix}`,
      start: match.index,
      end: match.index + match[0].length,
      hadPlus: sign === '+',
    });
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const marked = candidates.filter(isMarkedAmountToken);
  if (marked.length === 1) return marked[0];
  if (marked.length > 1) return null; // more than one confident candidate: don't guess

  // No suffixed/decimal-grouped/signed candidate at all: several bare
  // integers with nothing to rank them ('table for 4 500k' already resolved
  // above via the suffix; this is the pure 'table for 4 5' case). Decline.
  return null;
}

/** A token that isn't just a bare small integer: has a k/tr suffix, an explicit sign, or grouping/decimal punctuation. */
function isMarkedAmountToken(candidate: AmountToken): boolean {
  const bareDigits = candidate.token.replace(/^[+-]/, '');
  const hasSuffix = /[a-z]/i.test(bareDigits);
  const hasPunctuation = /[.,]/.test(bareDigits);
  const hasSign = candidate.token.startsWith('-') || candidate.hadPlus;
  return hasSuffix || hasPunctuation || hasSign;
}

/**
 * Resolves a matched date token to YYYY-MM-DD, or null when it doesn't name
 * a real calendar date (`new Date` silently rolls invalid month/day over
 * into a neighboring date instead of throwing, e.g. 02/31 -> Mar 3). A null
 * here still consumes the token from the message text; the caller treats a
 * null date the same as no date token at all (defaults to today at write).
 */
function resolveDateToken(token: string, today: Date): string | null {
  const lower = token.toLowerCase();
  if (lower === 'today') return toIsoDate(today);
  if (lower === 'yesterday') {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return toIsoDate(d);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    const [year, month, day] = token.split('-').map((p) => Number(p));
    return isRealCalendarDate(year, month, day) ? token : null;
  }

  // MM/DD or MM/DD/YYYY — assume US ordering, current year when omitted.
  const parts = token.split('/').map((p) => Number(p));
  const [month, day, yearPart] = parts;
  const year = yearPart === undefined ? today.getFullYear() : normalizeYear(yearPart);
  if (!isRealCalendarDate(year, month, day)) return null;
  return toIsoDate(new Date(year, month - 1, day));
}

/** Rejects month/day combinations `new Date` would silently roll over into a different date. */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

function normalizeYear(year: number): number {
  if (year >= 100) return year;
  return 2000 + year;
}

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

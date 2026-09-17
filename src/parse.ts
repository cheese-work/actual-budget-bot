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
  // 'income'/'in' keyword flips it positive. An explicit '-' stays negative.
  const hasExplicitSign = amountMatch.token.trim().startsWith('-') || amountMatch.hadPlus;
  const isIncome = amountMatch.hadPlus || /\b(income|in)\b/i.test(remaining);
  const amount = hasExplicitSign
    ? minorUnits
    : isIncome
      ? Math.abs(minorUnits)
      : -Math.abs(minorUnits);

  remaining = (remaining.slice(0, amountMatch.start) + remaining.slice(amountMatch.end))
    .replace(/\b(income|in)\b/gi, '')
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

/** Finds the first standalone number-like token, e.g. '45k', '1,234.56', '4.50'. */
function findAmountToken(text: string): AmountToken | null {
  const re = /([+-])?(\d[\d.,]*)\s*(k|tr)?\b/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const sign = match[1] ?? '';
    const digits = match[2];
    const suffix = match[3] ?? '';
    if (!/\d/.test(digits)) continue;
    return {
      token: `${sign === '-' ? '-' : ''}${digits}${suffix}`,
      start: match.index,
      end: match.index + match[0].length,
      hadPlus: sign === '+',
    };
  }
  return null;
}

function resolveDateToken(token: string, today: Date): string {
  const lower = token.toLowerCase();
  if (lower === 'today') return toIsoDate(today);
  if (lower === 'yesterday') {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return toIsoDate(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token;

  // MM/DD or MM/DD/YYYY — assume US ordering, current year when omitted.
  const parts = token.split('/').map((p) => Number(p));
  const [month, day, yearPart] = parts;
  const year = yearPart === undefined ? today.getFullYear() : normalizeYear(yearPart);
  const d = new Date(year, month - 1, day);
  return toIsoDate(d);
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

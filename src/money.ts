const vndFormatter = new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: 0,
});

/**
 * Actual stores amounts as integer minor units. For VND (zero decimal
 * places) that means the minor unit IS the unit: 45 000 VND is stored
 * as -45000, not -4500000. Do not multiply/divide by 100 here.
 */
export function formatVnd(minorUnits: number): string {
  return `${vndFormatter.format(minorUnits)} ₫`;
}

/** Signed VND amount with an explicit `+`/`-` sign, e.g. for a balance delta. */
export function formatVndDelta(minorUnits: number): string {
  const sign = minorUnits > 0 ? '+' : minorUnits < 0 ? '-' : '';
  return `${sign}${formatVnd(Math.abs(minorUnits))}`;
}

/**
 * VND has zero minor units, so a parsed VND amount IS the integer to store
 * (no *100). This bot's budget is VND-only; a fractional amount (US/EU
 * decimal form) is rounded to the nearest dong before storage.
 */
export function parseAmountToMinorUnits(raw: string): number | null {
  const shorthand = parseVndShorthand(raw);
  if (shorthand !== null) return shorthand;

  const numeric = parseDecimalAmount(raw);
  if (numeric === null) return null;
  return Math.round(numeric);
}

/** `45k` -> 45_000, `1tr` / `1 triệu` -> 1_000_000. Case-insensitive. */
function parseVndShorthand(raw: string): number | null {
  const match = raw.trim().match(/^(\d+(?:[.,]\d+)?)\s*(k|tr)$/i);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const multiplier = match[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  return Math.round(value * multiplier);
}

/**
 * Accepts US (1,234.56) and EU (1.234,56) grouped decimals, grouped
 * integers with no fractional part (1,200,000 / 1.200.000 / 1,200 / 1.200),
 * and plain integers/decimals.
 *
 * When both separators appear, the last one is the decimal point (standard
 * US/EU disambiguation). When only one separator kind appears, it's a
 * thousands group — not a fraction — whenever it repeats, or appears once
 * followed by exactly 3 digits: '1,200' is 1200 dong, not 1.2 dong; a bare
 * fractional-dong input isn't a real message this bot sees. A single
 * occurrence followed by 1-2 digits is still read as a decimal ('4.50').
 */
function parseDecimalAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?[\d.,]+$/.test(trimmed) || !/\d/.test(trimmed)) return null;

  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;

  const commaCount = (body.match(/,/g) ?? []).length;
  const dotCount = (body.match(/\./g) ?? []).length;
  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');

  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = body;
  } else if (commaCount > 0 && dotCount > 0) {
    // Both separators present: the last one is the decimal point.
    normalized =
      lastComma > lastDot
        ? body.replace(/\./g, '').replace(',', '.') // EU: '.' groups, ',' decimal
        : body.replace(/,/g, ''); // US: ',' groups, '.' decimal
  } else if (commaCount > 0) {
    // Only ',' appears: a group separator unless it's a single occurrence
    // followed by 1-2 digits (then it's a decimal point).
    normalized = isThousandsGroup(body, lastComma, commaCount)
      ? body.replace(/,/g, '')
      : body.replace(',', '.');
  } else {
    // Only '.' appears: same rule.
    normalized = isThousandsGroup(body, lastDot, dotCount) ? body.replace(/\./g, '') : body;
  }

  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * True when the sole separator kind in `body` is a thousands group rather
 * than a decimal point: it repeats, or its one occurrence is followed by
 * exactly 3 digits.
 */
function isThousandsGroup(body: string, lastIndex: number, count: number): boolean {
  if (count > 1) return true;
  const digitsAfter = body.length - lastIndex - 1;
  return digitsAfter === 3;
}

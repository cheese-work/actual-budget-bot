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
 * Accepts US (1,234.56) and EU (1.234,56) grouped decimals, plus plain
 * integers/decimals. Disambiguates by which separator appears last —
 * that one is the decimal point.
 */
function parseDecimalAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^-?[\d.,]+$/.test(trimmed) || !/\d/.test(trimmed)) return null;

  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;

  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');

  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = body;
  } else if (lastComma > lastDot) {
    // EU style: '.' groups thousands, ',' is the decimal point.
    normalized = body.replace(/\./g, '').replace(',', '.');
  } else {
    // US style: ',' groups thousands, '.' is the decimal point.
    normalized = body.replace(/,/g, '');
  }

  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

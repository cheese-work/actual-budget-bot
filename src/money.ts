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

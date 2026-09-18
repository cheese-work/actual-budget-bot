/**
 * Renders rows as a monospace text table for Telegram (wrapped in a
 * ```code block``` by the caller). Column widths are computed from the
 * widest cell so amounts stay right-aligned without extra libs.
 */
export function renderTextTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));

  const renderRow = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

  const lines = [renderRow(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(renderRow)];
  return lines.join('\n');
}

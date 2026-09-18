/**
 * Normalizes a merchant/payee string into a stable lookup key: lowercase,
 * diacritics folded (Vietnamese merchant names vary in accent usage between
 * receipts), punctuation stripped, whitespace collapsed, and a trailing
 * store-number suffix dropped ('GRAB*FOOD 123' / 'Circle K #4412' should hit
 * the same rule as a plain 'Grab Food' / 'Circle K' repeat).
 */
export function normalizeMerchant(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase();

  // '*' in a card descriptor separates brand from division ('GRAB*FOOD',
  // 'SHOPEE*PAY') — the division is part of the merchant identity, and the
  // vision model reports the same merchant as human-readable 'Grab Food'.
  // Truncating at the '*' would file those two under different keys and
  // break the repeat-merchant hit this store exists to provide, so treat it
  // as a separator. Only the trailing store/terminal number is dropped.
  const withoutStoreSuffix = folded
    .replace(/\*/g, ' ')
    .replace(/#\s*\d+\s*$/, '') // 'circle k #4412' -> 'circle k '
    .replace(/\b\d{2,}\s*$/, ''); // 'grab food 123' -> 'grab food '

  return withoutStoreSuffix
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Rule = { categoryId: string; categoryName: string };

/**
 * In-memory merchant -> category learning, same disposable-state shape as
 * TransactionStore. This is what makes the SECOND screenshot from a
 * merchant the user already confirmed once cost no categorization model
 * call: imageTransaction.ts checks here before ever considering a vision
 * category guess.
 */
class MerchantRuleStore {
  private rules = new Map<string, Rule>();

  remember(merchant: string, categoryId: string, categoryName: string): void {
    const key = normalizeMerchant(merchant);
    if (!key) return;
    this.rules.set(key, { categoryId, categoryName });
  }

  lookup(merchant: string): Rule | null {
    const key = normalizeMerchant(merchant);
    if (!key) return null;
    return this.rules.get(key) ?? null;
  }

  size(): number {
    return this.rules.size;
  }

  /** Test-only hygiene: clears learned rules between test cases. */
  clear(): void {
    this.rules.clear();
  }
}

export const merchantRules = new MerchantRuleStore();

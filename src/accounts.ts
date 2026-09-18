import * as actualApi from '@actual-app/api';

const BALANCE_ADJUSTMENT_CATEGORY = 'Balance Adjustment';

export type Account = {
  id: string;
  name: string;
  offbudget: boolean;
  closed: boolean;
};

function toAccount(a: {
  id: string;
  name: string;
  offbudget?: boolean;
  closed?: boolean;
}): Account {
  return { id: a.id, name: a.name, offbudget: !!a.offbudget, closed: !!a.closed };
}

export async function listAccounts(): Promise<Account[]> {
  const accounts = await actualApi.getAccounts();
  return accounts.map(toAccount);
}

export async function getBalance(accountId: string): Promise<number> {
  return actualApi.getAccountBalance(accountId);
}

export async function createFundingSource(params: {
  name: string;
  offbudget: boolean;
  openingBalance?: number;
}): Promise<string> {
  return actualApi.createAccount(
    { name: params.name, offbudget: params.offbudget },
    params.openingBalance,
  );
}

export class NonZeroBalanceError extends Error {
  constructor() {
    super('Account has a non-zero balance; set it to 0 before closing.');
  }
}

/**
 * Actual refuses to close an account with a non-zero balance unless a
 * transfer target is given (to move the leftover balance somewhere). This
 * bot doesn't offer transfer-target selection, so surface that as a clear
 * "zero it first" instruction instead of a raw API error.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

export async function closeFundingSource(accountId: string): Promise<void> {
  try {
    await actualApi.closeAccount(accountId);
  } catch (err) {
    if (errorMessage(err).includes('transferAccountId is required')) {
      throw new NonZeroBalanceError();
    }
    throw err;
  }
}

export async function reopenFundingSource(accountId: string): Promise<void> {
  await actualApi.reopenAccount(accountId);
}

/**
 * Find the "Balance Adjustment" category, creating it (and its group) if
 * missing. Actual has no dedicated adjustment concept — every reconciliation
 * writes a transaction against this category, so it must exist before the
 * first balance-set call, not be assumed present.
 */
async function ensureBalanceAdjustmentCategory(): Promise<string> {
  const groups = await actualApi.getCategoryGroups();
  for (const group of groups) {
    const match = group.categories?.find((c) => c.name === BALANCE_ADJUSTMENT_CATEGORY);
    if (match) return match.id;
  }

  let groupId = groups.find((g) => g.name === 'Bot')?.id;
  if (!groupId) {
    groupId = await actualApi.createCategoryGroup({ name: 'Bot', is_income: false, hidden: false });
  }
  return actualApi.createCategory({
    name: BALANCE_ADJUSTMENT_CATEGORY,
    group_id: groupId,
    is_income: false,
    hidden: false,
  });
}

export class AdjustmentWriteFailedError extends Error {
  constructor() {
    super('The balance adjustment was not written; balance is unchanged.');
  }
}

/**
 * Reconcile an account to a stated balance by writing one dated adjustment
 * transaction for the signed delta. Returns the delta that was written (0
 * means no transaction was written — the stated balance already matched).
 *
 * Uses `addTransactions`, not `importTransactions`: importTransactions runs
 * Actual's bank-sync fuzzy matcher (same account + same amount within ~7
 * days), which can silently match this adjustment onto an unrelated
 * existing transaction and *update* it instead of inserting — the amount
 * field is never touched by that update path, so the balance would not
 * move while the bot reports success. addTransactions always inserts.
 */
export async function setBalance(accountId: string, statedBalance: number): Promise<number> {
  const current = await actualApi.getAccountBalance(accountId);
  const delta = statedBalance - current;
  if (delta === 0) return 0;

  const categoryId = await ensureBalanceAdjustmentCategory();
  const result = await actualApi.addTransactions(accountId, [
    {
      date: new Date().toISOString().slice(0, 10),
      amount: delta,
      category: categoryId,
      payee_name: 'Balance Adjustment',
      notes: 'Reconciliation via Telegram bot',
    },
  ]);
  if (result !== 'ok') {
    throw new AdjustmentWriteFailedError();
  }
  return delta;
}

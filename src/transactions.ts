import { parseTransactionMessage } from './parse.js';
import { parseWithLlm, type FallbackResult } from './llmFallback.js';
import { transactionStore } from './transactionStore.js';
import {
  deleteTransaction,
  getAccounts,
  getCategories,
  getPayees,
  importTransactions,
} from './actualSession.js';
import { formatVnd } from './money.js';
import { logger } from './logger.js';
import { merchantRules } from './merchantRules.js';

export type LogResult =
  | { kind: 'logged'; summary: string }
  | { kind: 'needsConfirmation'; summary: string }
  | { kind: 'cannotParse' }
  | { kind: 'noAccount' }
  | { kind: 'duplicate' };

function toIsoDateToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Exported so imageTransaction.ts (a sibling write path that also lands
// through confirmPendingTransaction) resolves accounts/categories the same
// way instead of duplicating this logic.
export async function resolveAccountId(keyword: string | null): Promise<string | null> {
  const accounts = await getAccounts();
  const openAccounts = accounts.filter((a) => !a.closed);
  if (openAccounts.length === 0) return null;

  if (keyword) {
    const lower = keyword.toLowerCase();
    // Exact match first: an LLM-returned accountName is a real name from the
    // list we gave it, so it deserves an exact match before the looser
    // substring match used for a user-typed acc:/@ keyword fragment.
    const exact = openAccounts.find((a) => a.name.toLowerCase() === lower);
    if (exact) return exact.id;
    const match = openAccounts.find((a) => a.name.toLowerCase().includes(lower));
    if (match) return match.id;
  }

  // No keyword, or keyword didn't match: fall back to the single account
  // when there's exactly one — ambiguous otherwise.
  return openAccounts.length === 1 ? openAccounts[0].id : null;
}

/**
 * Handles one free-text message end to end: deterministic parse first (no
 * network call), LLM fallback only when that fails, confirm-before-write
 * only on the fallback path. `messageKey` is a caller-supplied idempotency
 * key (Telegram update_id) — a duplicate delivery of the same update is a
 * silent no-op, not a double-write.
 */
export async function handleTransactionMessage(
  userId: number,
  text: string,
  messageKey: string,
): Promise<LogResult> {
  if (!transactionStore.claimMessage(messageKey)) {
    logger.info('duplicate_message_ignored', { userId, messageKey });
    return { kind: 'duplicate' };
  }

  const deterministic = parseTransactionMessage(text);
  if (deterministic) {
    const accountId = await resolveAccountId(deterministic.accountKeyword);
    if (!accountId) {
      transactionStore.releaseClaim(messageKey);
      return { kind: 'noAccount' };
    }

    const importedId = `tgbot:${messageKey}`;
    let result;
    try {
      result = await importTransactions(accountId, [
        {
          account: accountId,
          date: deterministic.date ?? toIsoDateToday(),
          amount: deterministic.amount,
          payee_name: deterministic.payee ?? undefined,
          notes: deterministic.tag ? `#${deterministic.tag}` : undefined,
          imported_id: importedId,
        },
      ]);
    } catch (err) {
      // The write never landed — release the claim so a legitimate Telegram
      // retry of this same update isn't silently dropped as a duplicate.
      transactionStore.releaseClaim(messageKey);
      throw err;
    }

    const createdId = result.added[0];
    if (createdId) transactionStore.recordWrite(userId, createdId);

    return {
      kind: 'logged',
      summary: `Logged ${formatVnd(deterministic.amount)}${deterministic.payee ? ` — ${deterministic.payee}` : ''}`,
    };
  }

  const [accounts, categories, payees] = await Promise.all([
    getAccounts(),
    getCategories(),
    getPayees(),
  ]);
  const openAccounts = accounts.filter((a) => !a.closed);

  const fallback = await parseWithLlm(text, {
    accountNames: openAccounts.map((a) => a.name),
    categoryNames: categories.map((c) => c.name),
    payeeNames: payees.map((p) => p.name),
    today: toIsoDateToday(),
  });

  if (!fallback) return { kind: 'cannotParse' };

  transactionStore.setPending(userId, fallback, text);
  return {
    kind: 'needsConfirmation',
    summary: formatConfirmationPrompt(fallback),
  };
}

function formatConfirmationPrompt(result: FallbackResult): string {
  const parts = [formatVnd(result.amount)];
  if (result.payeeName) parts.push(result.payeeName);
  if (result.categoryName) parts.push(`(${result.categoryName})`);
  if (result.accountName) parts.push(`via ${result.accountName}`);
  parts.push(`on ${result.date}`);
  return `${parts.join(' ')}\n\nConfirm? /yes to log, /no to cancel.`;
}

export type ConfirmOutcome =
  | { kind: 'logged'; summary: string }
  | { kind: 'noPending' }
  | { kind: 'noAccount' };

/** Writes the user's currently pending LLM-parsed transaction. */
export async function confirmPendingTransaction(
  userId: number,
  messageKey: string,
): Promise<ConfirmOutcome> {
  const pending = transactionStore.takePending(userId);
  if (!pending) return { kind: 'noPending' };

  if (!transactionStore.claimMessage(messageKey)) {
    // Duplicate /yes tap: the original claim already wrote it, or is in
    // flight. Either way, do not write a second time.
    return { kind: 'noPending' };
  }

  const { result } = pending;
  const accountId = await resolveAccountId(result.accountName);
  if (!accountId) {
    transactionStore.releaseClaim(messageKey);
    return { kind: 'noAccount' };
  }

  const categoryId = await resolveCategoryId(result.categoryName);
  const importedId = `tgbot:${messageKey}`;

  let written;
  try {
    written = await importTransactions(accountId, [
      {
        account: accountId,
        date: result.date,
        amount: result.amount,
        payee_name: result.payeeName ?? undefined,
        category: categoryId ?? undefined,
        notes: result.notes ?? undefined,
        imported_id: importedId,
      },
    ]);
  } catch (err) {
    transactionStore.releaseClaim(messageKey);
    throw err;
  }

  const createdId = written.added[0];
  if (createdId) transactionStore.recordWrite(userId, createdId);

  // Learn the merchant -> category mapping so a repeat from the same
  // merchant (image path especially — see imageTransaction.ts) skips the
  // categorization model call entirely.
  if (result.payeeName && categoryId && result.categoryName) {
    merchantRules.remember(result.payeeName, categoryId, result.categoryName);
  }

  return {
    kind: 'logged',
    summary: `Logged ${formatVnd(result.amount)}${result.payeeName ? ` — ${result.payeeName}` : ''}`,
  };
}

export function cancelPendingTransaction(userId: number): boolean {
  const pending = transactionStore.takePending(userId);
  return pending !== null;
}

export async function resolveCategoryId(categoryName: string | null): Promise<string | null> {
  if (!categoryName) return null;
  const categories = await getCategories();
  const lower = categoryName.toLowerCase();
  const match = categories.find((c) => c.name.toLowerCase() === lower);
  return match?.id ?? null;
}

export type UndoOutcome = { kind: 'undone' } | { kind: 'nothingToUndo' };

/** Deletes the caller's last bot-created transaction. One /undo, one delete. */
export async function undoLastTransaction(userId: number): Promise<UndoOutcome> {
  const transactionId = transactionStore.takeLastWrite(userId);
  if (!transactionId) return { kind: 'nothingToUndo' };
  await deleteTransaction(transactionId);
  return { kind: 'undone' };
}

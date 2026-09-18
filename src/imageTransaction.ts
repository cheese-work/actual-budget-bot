import { parseTransactionMessage } from './parse.js';
import { extractFromImage, type VisionExtraction } from './visionExtract.js';
import { transactionStore } from './transactionStore.js';
import { resolveAccountId } from './transactions.js';
import { getAccounts, getCategories, getPayees } from './actualSession.js';
import { merchantRules, normalizeMerchant } from './merchantRules.js';
import { formatVnd } from './money.js';
import { logger } from './logger.js';
import type { FallbackResult } from './llmFallback.js';

export type ImageInput = { data: Uint8Array; mediaType: string };

export type ImageLogResult =
  | { kind: 'needsConfirmation'; summary: string }
  | { kind: 'cannotExtract' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'noAccount' }
  | { kind: 'duplicate' };

function toIsoDateToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Narrow injection seam for tests: Node's ESM live bindings aren't
 * configurable, so `node:test`'s `mock.method` cannot intercept a named
 * export across a module boundary (verified — it throws `Cannot redefine
 * property`). Rather than restructure the module graph, callers that need
 * a hermetic test override these instead of the real network/session calls.
 */
export type ImageTransactionDeps = {
  extractor: typeof extractFromImage;
  getAccounts: typeof getAccounts;
  getCategories: typeof getCategories;
  getPayees: typeof getPayees;
  resolveAccountId: typeof resolveAccountId;
};

const defaultDeps: ImageTransactionDeps = {
  extractor: extractFromImage,
  getAccounts,
  getCategories,
  getPayees,
  resolveAccountId,
};

/**
 * Handles one photo/document message end to end. The caption (if any) is
 * parsed with the SAME deterministic parser as the text path — a caption
 * field always overrides its vision-extracted counterpart, because the
 * user typed it on purpose. This never auto-writes: OCR on bank-app
 * screenshots misreads decimal separators (a stray '.' or ',' is a 1000x
 * error in VND) often enough that skipping confirmation risks corrupting
 * the ledger, even when the caption alone would have been enough to log
 * outright on the text path.
 */
export async function handleImageMessage(
  userId: number,
  image: ImageInput,
  caption: string | null,
  messageKey: string,
  deps: ImageTransactionDeps = defaultDeps,
): Promise<ImageLogResult> {
  if (!transactionStore.claimMessage(messageKey)) {
    logger.info('duplicate_image_message_ignored', { userId, messageKey });
    return { kind: 'duplicate' };
  }

  const captionParsed = caption ? parseTransactionMessage(caption) : null;

  const [accounts, categories, payees] = await Promise.all([
    deps.getAccounts(),
    deps.getCategories(),
    deps.getPayees(),
  ]);
  const openAccounts = accounts.filter((a) => !a.closed);

  const vision = await deps.extractor(image, {
    today: toIsoDateToday(),
    accountNames: openAccounts.map((a) => a.name),
    categoryNames: categories.map((c) => c.name),
    payeeNames: payees.map((p) => p.name),
  });

  const merged = mergeCaptionAndVision(captionParsed, vision);
  if (merged.amount === null) {
    transactionStore.releaseClaim(messageKey);
    return { kind: 'cannotExtract' };
  }

  // Category is model-free whenever this merchant was learned from a prior
  // confirmation (see transactions.ts#confirmPendingTransaction) — no
  // categorization call, and repeat screenshots from the same merchant cost
  // nothing extra on this axis.
  let categoryId: string | null = null;
  let categoryName: string | null = null;
  if (merged.payeeName) {
    const rule = merchantRules.lookup(merged.payeeName);
    if (rule) {
      categoryId = rule.categoryId;
      categoryName = rule.categoryName;
      logger.info('merchant_rule_hit', { merchant: normalizeMerchant(merged.payeeName) });
    } else {
      logger.info('merchant_rule_miss', { merchant: normalizeMerchant(merged.payeeName) });
    }
  }
  const accountId = await deps.resolveAccountId(merged.accountKeyword);
  if (!accountId) {
    transactionStore.releaseClaim(messageKey);
    return { kind: 'noAccount' };
  }
  const accountName = openAccounts.find((a) => a.id === accountId)?.name ?? null;

  const pending: FallbackResult = {
    amount: merged.amount,
    payeeName: merged.payeeName,
    categoryName,
    accountName,
    date: merged.date,
    notes: merged.tag ? `#${merged.tag}` : null,
  };

  transactionStore.setPending(userId, pending, caption ?? '<image>');

  return { kind: 'needsConfirmation', summary: formatSummary(pending, merged) };
}

type MergedFields = {
  amount: number | null; // signed
  amountFromCaption: boolean;
  payeeName: string | null;
  date: string;
  accountKeyword: string | null;
  tag: string | null;
};

/** Caption wins field-by-field over vision when the caption supplied that field. See parse.ts for ParsedTransaction shape. */
function mergeCaptionAndVision(
  caption: ReturnType<typeof parseTransactionMessage>,
  vision: VisionExtraction | null,
): MergedFields {
  const captionAmount = caption?.amount ?? null;
  const visionAmount = vision?.amount ?? null;

  const amount =
    captionAmount !== null ? captionAmount : visionAmount !== null ? -Math.abs(visionAmount) : null;

  return {
    amount,
    amountFromCaption: captionAmount !== null,
    payeeName: caption?.payee ?? vision?.merchant ?? null,
    date: caption?.date ?? vision?.date ?? toIsoDateToday(),
    accountKeyword: caption?.accountKeyword ?? vision?.sourceAccountHint ?? null,
    tag: caption?.tag ?? null,
  };
}

function formatSummary(pending: FallbackResult, merged: MergedFields): string {
  const provenance = merged.amountFromCaption ? '(from caption)' : '(from image)';
  const parts = [`${formatVnd(pending.amount)} ${provenance}`];
  if (pending.payeeName) parts.push(pending.payeeName);
  if (pending.categoryName) parts.push(`(${pending.categoryName})`);
  if (pending.accountName) parts.push(`via ${pending.accountName}`);
  parts.push(`on ${pending.date}`);
  return `${parts.join(' ')}\n\nConfirm? /yes to log, /no to cancel.`;
}

import type { FallbackResult } from './llmFallback.js';

type PendingConfirmation = {
  result: FallbackResult;
  originalText: string;
  createdAt: number;
};

type LastWrite = {
  transactionId: string;
  createdAt: number;
};

const PENDING_TTL_MS = 5 * 60 * 1000;
const PROCESSED_MESSAGE_TTL_MS = 60 * 60 * 1000;

/**
 * All per-user bot state, in-process. The container is single-instance and
 * this state is disposable (a restart just means an expired confirmation or
 * a shorter /undo window) so an in-memory Map is enough — no DB in this
 * skeleton yet.
 */
class TransactionStore {
  private pendingByUser = new Map<number, PendingConfirmation>();
  private lastWriteByUser = new Map<number, LastWrite>();
  private processedMessages = new Map<string, number>();

  setPending(userId: number, result: FallbackResult, originalText: string): void {
    this.pendingByUser.set(userId, { result, originalText, createdAt: Date.now() });
  }

  takePending(userId: number): PendingConfirmation | null {
    const entry = this.pendingByUser.get(userId);
    this.pendingByUser.delete(userId);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > PENDING_TTL_MS) return null;
    return entry;
  }

  clearPending(userId: number): void {
    this.pendingByUser.delete(userId);
  }

  recordWrite(userId: number, transactionId: string): void {
    this.lastWriteByUser.set(userId, { transactionId, createdAt: Date.now() });
  }

  /** Consumes the last write so a second /undo can't delete twice. */
  takeLastWrite(userId: number): string | null {
    const entry = this.lastWriteByUser.get(userId);
    this.lastWriteByUser.delete(userId);
    return entry?.transactionId ?? null;
  }

  /**
   * Idempotency guard against double-taps: a Telegram update_id (or
   * message_id, for edited/duplicate delivery) is claimed once. Returns
   * true if this is the first time we've seen it.
   */
  claimMessage(key: string): boolean {
    this.sweepProcessedMessages();
    if (this.processedMessages.has(key)) return false;
    this.processedMessages.set(key, Date.now());
    return true;
  }

  /**
   * Releases a claim after the write it guarded failed to land, so a
   * legitimate Telegram retry of the same update isn't dropped as a
   * duplicate of a transaction that was never actually written.
   */
  releaseClaim(key: string): void {
    this.processedMessages.delete(key);
  }

  private sweepProcessedMessages(): void {
    const cutoff = Date.now() - PROCESSED_MESSAGE_TTL_MS;
    for (const [key, seenAt] of this.processedMessages) {
      if (seenAt < cutoff) this.processedMessages.delete(key);
    }
  }
}

export const transactionStore = new TransactionStore();

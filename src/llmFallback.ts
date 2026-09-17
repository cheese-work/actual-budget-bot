import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { logger } from './logger.js';

export type FallbackContext = {
  accountNames: string[];
  categoryNames: string[];
  payeeNames: string[];
  today: string; // YYYY-MM-DD
};

export type FallbackResult = {
  amount: number; // signed minor units (VND: no scaling)
  payeeName: string | null;
  categoryName: string | null;
  accountName: string | null;
  date: string; // YYYY-MM-DD
  notes: string | null;
};

const TOOL_NAME = 'log_transaction';

/**
 * Single LLM call, only reached when the deterministic parser in parse.ts
 * returns null. Returns null (not a thrown error) when the model can't
 * confidently extract a transaction, so callers can reply asking the user
 * to rephrase instead of writing garbage.
 */
export async function parseWithLlm(
  text: string,
  context: FallbackContext,
): Promise<FallbackResult | null> {
  if (!config.anthropicApiKey) {
    logger.warn('llm_fallback_unconfigured');
    return null;
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 512,
    system:
      'You extract a single financial transaction from a free-text message for a personal ' +
      'budgeting bot. The budget currency is VND, stored as whole-dong integers ' +
      '(no cents, no *100 scaling — 45000 means 45,000 VND). ' +
      'A plain spending message is an expense: use a negative amount. ' +
      "Only use a positive amount when the message clearly describes income (e.g. 'salary', 'got paid', '+'). " +
      `Today's date is ${context.today}; resolve relative dates ('yesterday', 'last friday') against it. ` +
      'Prefer matching payeeName/categoryName/accountName to the provided existing lists over inventing new ones — ' +
      'reuse an existing name whenever it plausibly matches, otherwise return your best-guess new name. ' +
      'If the message does not describe a plausible single transaction, call the tool with amount 0 and notes null.',
    messages: [
      {
        role: 'user',
        content:
          `Message: ${JSON.stringify(text)}\n\n` +
          `Known accounts: ${JSON.stringify(context.accountNames)}\n` +
          `Known categories: ${JSON.stringify(context.categoryNames)}\n` +
          `Known payees: ${JSON.stringify(context.payeeNames)}`,
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    tools: [
      {
        name: TOOL_NAME,
        description: 'Record the single transaction extracted from the message.',
        input_schema: {
          type: 'object',
          properties: {
            amount: {
              type: 'integer',
              description: 'Signed whole-dong amount. Negative for expenses, positive for income.',
            },
            payeeName: { type: ['string', 'null'] },
            categoryName: { type: ['string', 'null'] },
            accountName: { type: ['string', 'null'] },
            date: { type: 'string', description: 'YYYY-MM-DD' },
            notes: { type: ['string', 'null'] },
          },
          required: ['amount', 'date'],
        },
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (!toolUse) {
    logger.warn('llm_fallback_no_tool_use');
    return null;
  }

  const input = toolUse.input as Partial<FallbackResult> & { amount?: unknown; date?: unknown };
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount === 0) {
    return null;
  }
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return null;
  }

  return {
    amount: Math.round(input.amount),
    payeeName: nullableString(input.payeeName),
    categoryName: nullableString(input.categoryName),
    accountName: nullableString(input.accountName),
    date: input.date,
    notes: nullableString(input.notes),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

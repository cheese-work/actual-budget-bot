import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { logger } from './logger.js';
import { createLlmClient } from './llmClient.js';

export type VisionExtraction = {
  amount: number | null; // POSITIVE magnitude in whole dong; caller applies the sign
  currency: string | null; // ISO-ish code as printed, e.g. 'VND', 'USD'
  merchant: string | null;
  date: string | null; // YYYY-MM-DD
  sourceAccountHint: string | null; // e.g. 'Techcombank •••1234', 'cash'
  confidence: 'high' | 'low';
};

export type VisionContext = {
  today: string; // YYYY-MM-DD
  accountNames: string[];
  categoryNames: string[];
  payeeNames: string[];
};

const TOOL_NAME = 'extract_transaction';
type SupportedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
const MEDIA_TYPES: ReadonlySet<string> = new Set<SupportedMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

/**
 * Single vision call over a bank-app screenshot or receipt photo. Returns
 * null only on transport/config failure (unconfigured client, no tool_use
 * block) — a legible-but-empty read still returns a VisionExtraction with
 * null fields so the caller can decide what to do with a partial read.
 */
export async function extractFromImage(
  image: { data: Uint8Array; mediaType: string },
  context: VisionContext,
): Promise<VisionExtraction | null> {
  const client = createLlmClient();
  if (!client) {
    logger.warn('vision_extract_unconfigured');
    return null;
  }

  const mediaType: SupportedMediaType = MEDIA_TYPES.has(image.mediaType)
    ? (image.mediaType as SupportedMediaType)
    : 'image/jpeg';

  const response = await client.messages.create({
    model: config.anthropicVisionModel,
    max_tokens: 512,
    system:
      'You extract a single financial transaction from a photo for a personal budgeting ' +
      'bot. The budget currency is VND, stored as whole-dong integers (no cents, no *100 ' +
      "scaling — 45000 means 45,000 VND). A Vietnamese receipt may write '45.000' or " +
      "'45,000' for forty-five thousand — both mean 45000, not 45. The photo may be a " +
      'bank-app screenshot or a paper receipt. Always return the amount as a POSITIVE ' +
      'magnitude, never signed — the caller decides expense vs income. ' +
      `Today's date is ${context.today}; resolve relative dates against it. ` +
      'Prefer matching merchant/sourceAccountHint to the provided existing lists when they ' +
      'plausibly match. Set confidence to "low" whenever the amount digits are not clearly ' +
      'legible (blur, glare, cropped) — never guess a number you cannot read cleanly.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: toBase64(image.data) },
          },
          {
            type: 'text',
            text:
              `Known accounts: ${JSON.stringify(context.accountNames)}\n` +
              `Known categories: ${JSON.stringify(context.categoryNames)}\n` +
              `Known payees: ${JSON.stringify(context.payeeNames)}`,
          },
        ],
      },
    ],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    tools: [
      {
        name: TOOL_NAME,
        description: 'Record the single transaction extracted from the image.',
        input_schema: {
          type: 'object',
          properties: {
            amount: {
              type: ['number', 'null'],
              description: 'Positive whole-dong magnitude, never signed.',
            },
            currency: { type: ['string', 'null'] },
            merchant: { type: ['string', 'null'] },
            date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
            sourceAccountHint: { type: ['string', 'null'] },
            confidence: { type: 'string', enum: ['high', 'low'] },
          },
          required: ['confidence'],
        },
      },
    ],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (!toolUse) {
    logger.warn('vision_extract_no_tool_use');
    return null;
  }

  const input = toolUse.input as Partial<VisionExtraction>;
  return {
    amount: validAmount(input.amount),
    currency: nullableString(input.currency),
    merchant: nullableString(input.merchant),
    date: validDate(input.date),
    sourceAccountHint: nullableString(input.sourceAccountHint),
    confidence: input.confidence === 'low' ? 'low' : input.confidence === 'high' ? 'high' : 'low',
  };
}

function validAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function validDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

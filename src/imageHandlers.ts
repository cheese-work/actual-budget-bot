import type { Bot, Context } from 'grammy';
import { config } from './config.js';
import { logger } from './logger.js';
import { handleImageMessage } from './imageTransaction.js';
import { pickPhotoSize, isSupportedImageMime, MAX_IMAGE_BYTES } from './imageScale.js';

const RESULT_MESSAGES = {
  cannotExtract:
    "Couldn't read a transaction off that image. A clearer photo, or a caption like `45k grab`, would help.",
  noAccount: 'No account to log into yet — set one up first.',
  unreadable: "Couldn't read that image — try a different photo.",
  tooLarge: `That image is over the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB limit — try a smaller file or a Telegram photo instead of a document.`,
} as const;

/** Downloads a Telegram file via the Bot API file endpoint into memory, capped at MAX_IMAGE_BYTES. */
async function downloadTelegramFile(fileId: string, bot: Bot): Promise<Uint8Array | null> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) return null;

  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) return null;
  return buffer;
}

/** Registers the photo and image-document -> transaction lanes. Text stays in logTransactionHandlers.ts. */
export function registerImageHandlers(bot: Bot): void {
  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) return;

    const size = pickPhotoSize(ctx.message.photo);
    if (!size) {
      await ctx.reply(RESULT_MESSAGES.unreadable);
      return;
    }

    const messageKey = `${ctx.chat.id}:${ctx.update.update_id}`;
    try {
      const data = await downloadTelegramFile(size.file_id, bot);
      if (!data) {
        await ctx.reply(RESULT_MESSAGES.tooLarge);
        return;
      }

      const result = await handleImageMessage(
        userId,
        { data, mediaType: 'image/jpeg' }, // Telegram re-encodes photo variants as JPEG
        ctx.message.caption ?? null,
        messageKey,
      );
      await replyForResult(ctx, result);
    } catch (err) {
      logger.error('image_transaction_failed', { err: String(err) });
      await ctx.reply('Something went wrong reading that image — see logs.');
    }
  });

  bot.on('message:document', async (ctx, next) => {
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? '';
    if (!isSupportedImageMime(mime)) return next(); // not an image document: let another handler see it

    const userId = ctx.from?.id;
    if (userId === undefined) return;

    if (doc.file_size !== undefined && doc.file_size > MAX_IMAGE_BYTES) {
      await ctx.reply(RESULT_MESSAGES.tooLarge);
      return;
    }

    const messageKey = `${ctx.chat.id}:${ctx.update.update_id}`;
    try {
      const data = await downloadTelegramFile(doc.file_id, bot);
      if (!data) {
        await ctx.reply(RESULT_MESSAGES.tooLarge);
        return;
      }

      const result = await handleImageMessage(
        userId,
        { data, mediaType: mime },
        ctx.message.caption ?? null,
        messageKey,
      );
      await replyForResult(ctx, result);
    } catch (err) {
      logger.error('image_transaction_failed', { err: String(err) });
      await ctx.reply('Something went wrong reading that image — see logs.');
    }
  });
}

async function replyForResult(
  ctx: Context,
  result: Awaited<ReturnType<typeof handleImageMessage>>,
): Promise<void> {
  switch (result.kind) {
    case 'needsConfirmation':
      await ctx.reply(result.summary);
      break;
    case 'cannotExtract':
      await ctx.reply(RESULT_MESSAGES.cannotExtract);
      break;
    case 'noAccount':
      await ctx.reply(RESULT_MESSAGES.noAccount);
      break;
    case 'unsupported':
      await ctx.reply(result.reason);
      break;
    case 'duplicate':
      // Same reasoning as the text path (logTransactionHandlers.ts): stay
      // silent rather than telling the user their already-processed image
      // "couldn't be read".
      break;
  }
}

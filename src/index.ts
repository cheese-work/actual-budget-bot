import { createBot } from './bot.js';
import { startActualSession, stopActualSession } from './actualSession.js';
import { logger } from './logger.js';
import { getVersionInfo } from './version.js';

async function main(): Promise<void> {
  const versionInfo = getVersionInfo();
  await startActualSession();

  const bot = createBot();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_start', { signal });
    await bot.stop();
    await stopActualSession();
    logger.info('shutdown_complete');
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await bot.start({
    onStart: () => logger.info('bot_started', versionInfo),
  });
}

main().catch((err) => {
  logger.error('fatal_startup_error', { err: String(err) });
  process.exit(1);
});

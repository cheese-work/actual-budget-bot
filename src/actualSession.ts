import * as actualApi from '@actual-app/api';
import { config } from './config.js';
import { logger } from './logger.js';

let ready = false;
let syncTimer: NodeJS.Timeout | undefined;

export async function startActualSession(): Promise<void> {
  if (ready) return;

  await actualApi.init({
    dataDir: config.actualDataDir,
    serverURL: config.actualServerUrl,
    password: config.actualPassword,
  });
  await actualApi.downloadBudget(config.actualSyncId);
  ready = true;
  logger.info('actual_session_started', { syncId: config.actualSyncId });

  syncTimer = setInterval(() => {
    actualApi
      .sync()
      .then(() => logger.info('actual_sync_ok'))
      .catch((err: unknown) => logger.error('actual_sync_failed', { err: String(err) }));
  }, config.syncIntervalMs);
  syncTimer.unref();
}

export function isActualReady(): boolean {
  return ready;
}

export async function getAccountCount(): Promise<number> {
  const accounts = await actualApi.getAccounts();
  return accounts.length;
}

export async function stopActualSession(): Promise<void> {
  if (syncTimer) clearInterval(syncTimer);
  if (!ready) return;
  await actualApi.shutdown();
  ready = false;
  logger.info('actual_session_stopped');
}

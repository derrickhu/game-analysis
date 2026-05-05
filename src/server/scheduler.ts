import cron from 'node-cron';

import { GAME_CONFIGS } from '../shared/game-config';
import { getConfig } from './config';
import { ingestCloudbaseSnapshots } from './cloudbase-ingest';

let started = false;

export function startScheduler(): void {
  const config = getConfig();
  if (!config.schedulerEnabled || started) return;
  started = true;

  for (const game of GAME_CONFIGS) {
    cron.schedule(game.ingestCron, async () => {
      try {
        console.log(`[scheduler] 开始拉取 ${game.displayName} (${game.gameKey})`);
        const result = await ingestCloudbaseSnapshots({
          env: game.cloudEnv,
          gameKey: game.gameKey,
          collectionName: game.collectionName,
          pageSize: 100,
        });
        console.log(
          `[scheduler] 完成拉取 ${game.gameKey}: imported=${result.imported}, changed=${result.changed}`,
        );
      } catch (error) {
        console.error(`[scheduler] 拉取失败 ${game.gameKey}:`, error);
      }
    });
  }
}

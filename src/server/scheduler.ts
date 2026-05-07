import cron from 'node-cron';

import { GAME_CONFIGS } from '../shared/game-config';
import { getConfig } from './config';
import { ingestCloudbaseSnapshots } from './cloudbase-ingest';
import { ANALYTICS_GAMES, getEnabledAnalyticsGames } from './config/analytics-games';
import { ingestEventsForGame } from './jobs/ingest-events';
import { cleanExpiredEvents } from './jobs/clean-expired-events';

let started = false;

export function startScheduler(): void {
  const config = getConfig();
  if (!config.schedulerEnabled || started) return;
  started = true;

  // 1) 存档快照差分（已下线）：GAME_CONFIGS 当前为空，循环不会注册 cron
  //    任何游戏接入 SDK 后都不应该再回到这条链路；保留循环只是为了让 hot-fix 时还能临时塞回去
  for (const game of GAME_CONFIGS) {
    cron.schedule(game.ingestCron, async () => {
      try {
        console.log(`[scheduler] 开始拉取 ${game.displayName} 存档 (${game.gameKey})`);
        const result = await ingestCloudbaseSnapshots({
          env: game.cloudEnv,
          gameKey: game.gameKey,
          collectionName: game.collectionName,
          pageSize: 100,
        });
        console.log(
          `[scheduler] 完成存档拉取 ${game.gameKey}: imported=${result.imported}, changed=${result.changed}`,
        );
      } catch (error) {
        console.error(`[scheduler] 存档拉取失败 ${game.gameKey}:`, error);
      }
    });
  }

  // 2) 事件流增量拉取：每 5 分钟整点，只对「已接入 SDK 在产数据」的游戏串行拉一遍
  //    未接入的游戏在 ANALYTICS_GAMES 里 enabled=false，这里直接跳过避免空跑浪费 CloudBase 配额
  //    与聚合 bucket 同样是 5 分钟粒度，dashboard 端到端延迟 ~5 分钟，对广告业务完全够用，
  //    比之前 30s 一次节省 ~10 倍 CloudBase 调用次数
  const eventsCron = process.env.ANALYTICS_EVENTS_CRON || '*/5 * * * *';
  cron.schedule(eventsCron, async () => {
    for (const game of getEnabledAnalyticsGames()) {
      try {
        const summary = await ingestEventsForGame(game);
        if (summary.fetched > 0) {
          console.log(
            `[scheduler] events ${game.gameKey}: fetched=${summary.fetched}, inserted=${summary.inserted}, ` +
              `cursor=${summary.cursorBefore} -> ${summary.cursorAfter}, adMinuteRows=${summary.newAdMinuteRows}`,
          );
        }
      } catch (error) {
        console.error(`[scheduler] events 拉取失败 ${game.gameKey}:`, error);
      }
    }
  });

  // 3) 兜底清理过期事件：每天凌晨 3 点跑一次
  const cleanCron = process.env.ANALYTICS_CLEAN_CRON || '0 3 * * *';
  const retentionDays = Number(process.env.ANALYTICS_RETENTION_DAYS) || 30;
  cron.schedule(cleanCron, async () => {
    try {
      const summary = await cleanExpiredEvents(retentionDays);
      console.log(
        `[scheduler] events 清理: retention=${summary.retentionDays}d, ` +
          `local=${summary.localDeleted}, cloud=${summary.cloudDeleted}, ` +
          `errors=${summary.cloudErrors.length}`,
      );
      if (summary.cloudErrors.length > 0) {
        for (const err of summary.cloudErrors) console.warn(`[scheduler] events 清理警告: ${err}`);
      }
    } catch (error) {
      console.error('[scheduler] events 清理失败:', error);
    }
  });

  const enabledKeys = getEnabledAnalyticsGames().map((g) => g.gameKey);
  console.log(
    `[scheduler] started: snapshots(games=${GAME_CONFIGS.length}), ` +
      `events(enabled=${enabledKeys.length}/${ANALYTICS_GAMES.length} [${enabledKeys.join(',')}], cron=${eventsCron}), ` +
      `cleanup(cron=${cleanCron}, retentionDays=${retentionDays})`,
  );
}

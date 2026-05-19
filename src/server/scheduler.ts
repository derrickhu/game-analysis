import cron from 'node-cron';

import { GAME_CONFIGS } from '../shared/game-config';
import { getConfig } from './config';
import { ingestCloudbaseSnapshots } from './cloudbase-ingest';
import { ANALYTICS_GAMES, getEnabledAnalyticsGames } from './config/analytics-games';
import { ingestEventsForGame } from './jobs/ingest-events';
import { cleanExpiredEvents } from './jobs/clean-expired-events';
import { ingestHuahuaSnapshots } from './jobs/ingest-huahua-snapshot';
import { recomputeCohortLtv, recomputeUserDaily } from './metrics/ltv';
import { recomputeRetentionCohorts } from './metrics/retention';
import { recomputeLevelPassRates } from './metrics/level-pass-rate';

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
  // 双 retention：本地 90 天（D7 留存兜底 + 历史回看）/ 云端 7 天（CloudBase 配额限制）
  // 通过 ANALYTICS_RETENTION_DAYS_LOCAL / ANALYTICS_RETENTION_DAYS_CLOUD 单独覆盖
  // 兼容老变量 ANALYTICS_RETENTION_DAYS：未设新变量时，老变量同时作用于本地和云端
  const cleanCron = process.env.ANALYTICS_CLEAN_CRON || '0 3 * * *';
  const legacyRetention = Number(process.env.ANALYTICS_RETENTION_DAYS);
  const retentionDaysLocal =
    Number(process.env.ANALYTICS_RETENTION_DAYS_LOCAL) || (Number.isFinite(legacyRetention) && legacyRetention > 0 ? legacyRetention : 90);
  const retentionDaysCloud =
    Number(process.env.ANALYTICS_RETENTION_DAYS_CLOUD) || (Number.isFinite(legacyRetention) && legacyRetention > 0 ? legacyRetention : 7);
  cron.schedule(cleanCron, async () => {
    try {
      const summary = await cleanExpiredEvents({
        retentionDaysLocal,
        retentionDaysCloud,
        triggerSource: 'cron',
      });
      console.log(
        `[scheduler] events 清理: local_retention=${summary.retentionDaysLocal}d cloud_retention=${summary.retentionDaysCloud}d ` +
          `local_deleted=${summary.localDeleted} cloud_deleted=${summary.cloudDeleted} ` +
          `errors=${summary.cloudErrors.length} duration=${summary.durationMs}ms`,
      );
      if (summary.cloudErrors.length > 0) {
        for (const err of summary.cloudErrors) console.warn(`[scheduler] events 清理警告: ${err}`);
      }
    } catch (error) {
      console.error('[scheduler] events 清理失败:', error);
    }
  });

  // 4) 玩家档案快照（player snapshot）：每天上海时区凌晨 4 点全量拉一次
  //    与事件流互补：事件流看"做了什么"，快照看"现在是什么状态"
  //    cron 用 'America/Los_Angeles' 调时区会更稳，这里默认服务器/容器时区已是 UTC+8（华东）
  //    通过 PLAYER_SNAPSHOT_CRON 环境变量可覆盖（如 '0 4 * * *'）
  const playerSnapshotCron = process.env.PLAYER_SNAPSHOT_CRON || '0 4 * * *';
  const snapshotRetentionDays = Math.max(7, Number(process.env.PLAYER_SNAPSHOT_RETENTION_DAYS) || 30);
  cron.schedule(playerSnapshotCron, async () => {
    try {
      console.log('[scheduler] 开始拉取 huahua 玩家档案快照');
      const result = await ingestHuahuaSnapshots({
        triggerSource: 'cron',
        retentionDays: snapshotRetentionDays,
      });
      if (result.ok) {
        console.log(
          `[scheduler] 玩家快照 huahua: date=${result.snapshot_date} fetched=${result.fetched} ` +
            `inserted=${result.inserted} pruned=${result.pruned_old_rows} duration=${result.duration_ms}ms`,
        );
      } else {
        console.error(`[scheduler] 玩家快照 huahua 拉取失败: ${result.error}`);
      }
    } catch (error) {
      console.error('[scheduler] 玩家快照 huahua 拉取异常:', error);
    }
  });

  // 5) 通用 LTV / user_daily 回算：每 15 分钟把所有已接入 SDK 的游戏批量重算一次
  //    - 不回算等于 ROI 页面看到的 game_new_users / d30_projected_ltv 永远是上一次手动回算时的快照
  //    - 频率 15 分钟与 events 拉取 5 分钟相比已经留了缓冲，避免事件还未入库就回算空数据
  //    - 通过 LTV_RECOMPUTE_CRON 覆盖；服务启动后立即跑一次保证刚部署也有最新底座
  const ltvCron = process.env.LTV_RECOMPUTE_CRON || '*/15 * * * *';
  const runLtvRecompute = async (trigger: 'cron' | 'startup') => {
    for (const game of getEnabledAnalyticsGames()) {
      try {
        const userDaily = await recomputeUserDaily(game.gameKey);
        const cohort = await recomputeCohortLtv(game.gameKey);
        const retention = await recomputeRetentionCohorts(game.gameKey, {
          fromDate: userDaily.from_date,
          toDate: userDaily.to_date,
        });
        if (userDaily.rows > 0 || cohort.rows > 0 || retention.rows > 0) {
          console.log(
            `[scheduler] ltv(${trigger}) ${game.gameKey}: user_daily=${userDaily.rows}, ` +
              `cohort=${cohort.rows}, retention=${retention.rows}, range=${userDaily.from_date}~${userDaily.to_date}`,
          );
        }
      } catch (error) {
        console.error(`[scheduler] ltv 回算失败 ${game.gameKey}:`, error);
      }
    }
  };
  cron.schedule(ltvCron, () => {
    void runLtvRecompute('cron');
  });
  // 进程启动后异步触发一次，避免 dashboard 第一次打开时看到的还是上次部署前的数据
  setTimeout(() => {
    void runLtvRecompute('startup');
  }, 5_000);

  // 6) 闯关模式近 30 天通关率：每天凌晨 4:20 计算完整的最近 30 天，并发布给游戏端读取。
  const levelPassRateCron = process.env.LEVEL_PASS_RATE_CRON || '20 4 * * *';
  const runLevelPassRateRecompute = async (trigger: 'cron' | 'startup') => {
    try {
      const result = await recomputeLevelPassRates({ gameKey: 'hotpot', windowDays: 30, publish: true });
      console.log(
        `[scheduler] level_pass_rate(${trigger}) ${result.game_key}: rows=${result.rows}, ` +
          `range=${result.window_start_date}~${result.window_end_date}, published=${result.published}`,
      );
    } catch (error) {
      console.error(`[scheduler] level_pass_rate 回算失败 (${trigger}):`, error);
    }
  };
  cron.schedule(levelPassRateCron, () => {
    void runLevelPassRateRecompute('cron');
  });
  setTimeout(() => {
    void runLevelPassRateRecompute('startup');
  }, 8_000);

  const enabledKeys = getEnabledAnalyticsGames().map((g) => g.gameKey);
  console.log(
    `[scheduler] started: snapshots(games=${GAME_CONFIGS.length}), ` +
      `events(enabled=${enabledKeys.length}/${ANALYTICS_GAMES.length} [${enabledKeys.join(',')}], cron=${eventsCron}), ` +
      `cleanup(cron=${cleanCron}, local=${retentionDaysLocal}d, cloud=${retentionDaysCloud}d), ` +
      `player_snapshot(cron=${playerSnapshotCron}, retention=${snapshotRetentionDays}d), ` +
      `ltv_recompute(cron=${ltvCron}), level_pass_rate(cron=${levelPassRateCron})`,
  );
}

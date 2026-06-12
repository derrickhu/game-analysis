import cron from 'node-cron';

import { GAME_CONFIGS } from '../shared/game-config';
import { getConfig } from './config';
import { ingestCloudbaseSnapshots } from './cloudbase-ingest';
import { ANALYTICS_GAMES, getEnabledAnalyticsGames } from './config/analytics-games';
import { ingestEventsForGame } from './jobs/ingest-events';
import { cleanExpiredEvents } from './jobs/clean-expired-events';
import { ingestTencentAdsBusinessInputs } from './jobs/ingest-tencent-ads';
import { ingestTencentAdsInsights } from './jobs/ingest-tencent-ads-insights';
import { ingestWechatPublisherBusinessInputs } from './jobs/ingest-wechat-publisher';
import { ingestHuahuaSnapshots } from './jobs/ingest-huahua-snapshot';
import { ingestHotpotSnapshots } from './jobs/ingest-hotpot-snapshot';
import { recomputeCohortLtv, recomputeUserDaily } from './metrics/ltv';
import { recomputeRetentionCohorts } from './metrics/retention';
import { recomputeLevelPassRates } from './metrics/level-pass-rate';
import { recomputeAttribution } from './metrics/attribution';
import { runLoggedTask } from './process-lifecycle';

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
  cron.schedule(eventsCron, () => {
    runLoggedTask('scheduler/events', async () => {
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
  });

  // 3) 兜底清理过期事件：每天凌晨 3 点（可通过 ANALYTICS_CLEAN_CRON 覆盖）
  //    与 LTV 默认 cron（7,22,37,52 分）错开，降低同进程 node-cron 漏触发风险。
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
  const runPlayerSnapshotIngest = async (gameKey: 'huahua' | 'hotpot') => {
    try {
      console.log(`[scheduler] 开始拉取 ${gameKey} 玩家档案快照`);
      const result = gameKey === 'hotpot'
        ? await ingestHotpotSnapshots({ triggerSource: 'cron', retentionDays: snapshotRetentionDays })
        : await ingestHuahuaSnapshots({ triggerSource: 'cron', retentionDays: snapshotRetentionDays });
      if (result.ok) {
        console.log(
          `[scheduler] 玩家快照 ${gameKey}: date=${result.snapshot_date} fetched=${result.fetched} ` +
            `inserted=${result.inserted} pruned=${result.pruned_old_rows} duration=${result.duration_ms}ms`,
        );
      } else {
        console.error(`[scheduler] 玩家快照 ${gameKey} 拉取失败: ${result.error}`);
      }
    } catch (error) {
      console.error(`[scheduler] 玩家快照 ${gameKey} 拉取异常:`, error);
    }
  };

  cron.schedule(playerSnapshotCron, async () => {
    await runPlayerSnapshotIngest('huahua');
    await runPlayerSnapshotIngest('hotpot');
  });

  // 5) 通用 LTV / user_daily 回算：默认每 15 分钟一次，但刻意错开整点/刻钟
  //    （7,22,37,52），避免与 03:00 事件清理、04:00 玩家快照等同进程运维任务撞车。
  //    Node 单线程：LTV 重算若与 cleanup 同时落在 03:00，会占满 event loop，node-cron 会漏触发清理。
  //    通过 LTV_RECOMPUTE_CRON 覆盖；服务启动后 5s 仍立即跑一次保证刚部署也有最新底座。
  const ltvCron = process.env.LTV_RECOMPUTE_CRON || '7,22,37,52 * * * *';
  const runLtvRecompute = async (trigger: 'cron' | 'startup') => {
    for (const game of getEnabledAnalyticsGames()) {
      try {
        const userDaily = await recomputeUserDaily(game.gameKey);
        const cohort = await recomputeCohortLtv(game.gameKey);
        const retention = await recomputeRetentionCohorts(game.gameKey, {
          fromDate: userDaily.from_date,
          toDate: userDaily.to_date,
        });
        const attribution = await recomputeAttribution(game.gameKey, {
          fromDate: userDaily.from_date,
          toDate: userDaily.to_date,
        });
        if (userDaily.rows > 0 || cohort.rows > 0 || retention.rows > 0 || attribution.user_daily_rows > 0) {
          console.log(
            `[scheduler] ltv(${trigger}) ${game.gameKey}: user_daily=${userDaily.rows}, ` +
              `cohort=${cohort.rows}, retention=${retention.rows}, ` +
              `attribution_daily=${attribution.user_daily_rows}, postback=${attribution.postback_rows}, ` +
              `range=${userDaily.from_date}~${userDaily.to_date}`,
          );
        }
      } catch (error) {
        console.error(`[scheduler] ltv 回算失败 ${game.gameKey}:`, error);
      }
    }
  };
  cron.schedule(ltvCron, () => {
    runLoggedTask('scheduler/ltv', () => runLtvRecompute('cron'));
  });
  // 进程启动后异步触发一次，避免 dashboard 第一次打开时看到的还是上次部署前的数据
  setTimeout(() => {
    runLoggedTask('scheduler/ltv-startup', () => runLtvRecompute('startup'));
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

  // 7) 腾讯广告买量日报：每天 9:10 拉昨天及最近 7 天，自动补录投放花费/点击/曝光。
  // 腾讯日报通常 8 点后完整，保留 1 小时缓冲；回拉 7 天用于修正平台延迟归因。
  const tencentAdsCron = process.env.TENCENT_ADS_INGEST_CRON || '10 9 * * *';
  const runTencentAdsIngest = async (trigger: 'cron' | 'startup') => {
    try {
      const result = await ingestTencentAdsBusinessInputs();
      const summary = result.games
        .map((game) =>
          game.error
            ? `${game.game_key}:${game.account_id}:error=${game.error}`
            : `${game.game_key}:${game.account_id}:fetched=${game.fetched_rows},saved=${game.saved_rows}`,
        )
        .join('; ');
      console.log(
        `[scheduler] tencent_ads(${trigger}) range=${result.from_date}~${result.to_date} ok=${result.ok} ${summary}`,
      );
    } catch (error) {
      console.error(`[scheduler] 腾讯广告自动补录失败 (${trigger}):`, error);
    }
  };
  cron.schedule(tencentAdsCron, () => {
    void runTencentAdsIngest('cron');
  });
  setTimeout(() => {
    void runTencentAdsIngest('startup');
  }, 12_000);

  // 8) 腾讯广告投放洞察：每天 9:40 拉定向标签和创意素材，错峰于基础日报。默认只回拉最近 7 天；历史 30/90 天用手动 backfill。
  const tencentAdsInsightsCron = process.env.TENCENT_ADS_INSIGHTS_INGEST_CRON || '40 9 * * *';
  const runTencentAdsInsightsIngest = async (trigger: 'cron' | 'startup') => {
    try {
      const result = await ingestTencentAdsInsights();
      const summary = result.games
        .map((game) =>
          game.errors.length > 0
            ? `${game.game_key}:${game.account_id}:errors=${game.errors.length}`
            : `${game.game_key}:${game.account_id}:targeting=${game.targeting_rows},creative=${game.creative_rows},audience=${game.audience_rows}`,
        )
        .join('; ');
      console.log(
        `[scheduler] tencent_ads_insights(${trigger}) range=${result.from_date}~${result.to_date} ok=${result.ok} ${summary}`,
      );
    } catch (error) {
      console.error(`[scheduler] 腾讯广告洞察拉取失败 (${trigger}):`, error);
    }
  };
  cron.schedule(tencentAdsInsightsCron, () => {
    void runTencentAdsInsightsIngest('cron');
  });
  setTimeout(() => {
    void runTencentAdsInsightsIngest('startup');
  }, 18_000);

  // 9) 微信流量主日报：当天多次回拉最近窗口真实收入/曝光，覆盖商业化 LTV 真实 eCPM。
  // 微信侧昨日数据经常晚于上午开放，保留 16:10 / 23:10 二次补偿，避免 ROI 页连续缺收入。
  const wechatPublisherCron = process.env.WECHAT_PUBLISHER_INGEST_CRON || '10 10,16,23 * * *';
  const runWechatPublisherIngest = async (trigger: 'cron' | 'startup') => {
    try {
      const result = await ingestWechatPublisherBusinessInputs({ triggerSource: trigger });
      const summary = result.games
        .map((game) =>
          game.error
            ? `${game.game_key}:${game.app_id}:error=${game.error}`
            : `${game.game_key}:${game.app_id}:fetched=${game.fetched_rows},raw=${game.saved_raw_rows},business=${game.saved_business_rows}`,
        )
        .join('; ');
      console.log(
        `[scheduler] wechat_publisher(${trigger}) range=${result.from_date}~${result.to_date} ok=${result.ok} ${summary}`,
      );
    } catch (error) {
      console.error(`[scheduler] 微信流量主自动补录失败 (${trigger}):`, error);
    }
  };
  cron.schedule(wechatPublisherCron, () => {
    void runWechatPublisherIngest('cron');
  });
  setTimeout(() => {
    void runWechatPublisherIngest('startup');
  }, 15_000);

  const enabledKeys = getEnabledAnalyticsGames().map((g) => g.gameKey);
  console.log(
    `[scheduler] started: snapshots(games=${GAME_CONFIGS.length}), ` +
      `events(enabled=${enabledKeys.length}/${ANALYTICS_GAMES.length} [${enabledKeys.join(',')}], cron=${eventsCron}), ` +
      `cleanup(cron=${cleanCron}, local=${retentionDaysLocal}d, cloud=${retentionDaysCloud}d), ` +
      `player_snapshot(cron=${playerSnapshotCron}, retention=${snapshotRetentionDays}d), ` +
      `ltv_recompute(cron=${ltvCron}), level_pass_rate(cron=${levelPassRateCron}), ` +
      `tencent_ads(cron=${tencentAdsCron}), tencent_ads_insights(cron=${tencentAdsInsightsCron}), ` +
      `wechat_publisher(cron=${wechatPublisherCron})`,
  );
}

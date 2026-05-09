import tcb from '@cloudbase/node-sdk';

import { ANALYTICS_EVENTS_COLLECTION, ANALYTICS_GAMES } from '../config/analytics-games';
import {
  countOldEvents,
  deleteOldEvents,
  recordCleanupRun,
  type CleanupRunRecord,
} from '../analytics-db';

/**
 * ── 设计要点 ──────────────────────────────────────────────────────────
 *
 * 1. 双 retention：本地保留 90 天（长期分析回看 / D7 留存兜底），云端只保留 7 天
 *    （CloudBase 配额有限、文档体积大）。两个 retention 独立，环境变量分别控制。
 *
 * 2. 防呆白名单：清理操作只能命中 DELETION_WHITELIST 里的集合名 / 表名。
 *    任何尝试操作 *_playerData / 玩家数据库等敏感集合都会立即抛异常拒绝执行。
 *    这是最关键的"铁锁"——以后任何人改 ANALYTICS_EVENTS_COLLECTION 常量都拦得住。
 *
 * 3. 限速：云端 .remove(1000) 每批之间 sleep 500ms，单游戏单次最多删 50 万条。
 *    避免第一次清理累积量大时撞 CloudBase API 单分钟调用上限被 502。
 *    没删完的留给次日 cron 接力，最坏情况几天内追平。
 *
 * 4. dry-run：传 dryRun=true 时只数 / 模拟，不真删。第一次跑必须用 dry-run 验证数量。
 *
 * 5. 全程入库：每次运行（含 dry-run）落 analytics_cleanup_runs 表，dashboard 可见。
 *
 * 6. trigger_source：cron 自动跑 vs manual 手动触发，区分开排查方便。
 */

const DEFAULT_RETENTION_DAYS_LOCAL = 90;
const DEFAULT_RETENTION_DAYS_CLOUD = 7;
const CLOUD_BATCH_SIZE = 1000;
const CLOUD_BATCH_SLEEP_MS = 500;
const CLOUD_MAX_DELETE_PER_GAME_PER_RUN = 500_000;

/**
 * 「允许被清理类操作命中」的集合 / 表名白名单。
 *
 * 任何不在此白名单里的目标都会让 cleanExpiredEvents 立即抛错——给玩家数据库加一道铁锁。
 * 集合名（云端）和表名（本地 MySQL）共用同一份白名单，名字也确实一致。
 */
const DELETION_WHITELIST: ReadonlySet<string> = new Set(['analytics_events']);

function assertWhitelisted(collection: string, where: string): void {
  if (!DELETION_WHITELIST.has(collection)) {
    throw new Error(
      `[CRITICAL][cleanup] refuse to delete from non-whitelisted collection: "${collection}" at ${where}. ` +
        `If this is legitimate, explicitly add it to DELETION_WHITELIST in clean-expired-events.ts.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CleanupSummary {
  retentionDaysLocal: number;
  retentionDaysCloud: number;
  cutoffLocalMs: number;
  cutoffCloudMs: number;
  localDeleted: number;
  cloudDeleted: number;
  cloudErrors: string[];
  dryRun: boolean;
  triggerSource: 'cron' | 'manual';
  durationMs: number;
}

export interface CleanupOptions {
  retentionDaysLocal?: number;
  retentionDaysCloud?: number;
  /** dry-run 只数将要删多少条，不真删，第一次必跑 */
  dryRun?: boolean;
  /** 区分 cron 自动跑还是 dashboard 手动按钮触发 */
  triggerSource?: 'cron' | 'manual';
}

/**
 * 兜底清理：本地 MySQL 长保留 + CloudDB 短保留。
 *
 * 安全模型：
 * - 只动 analytics_events 集合 / 表（白名单守卫）
 * - WHERE 子句必带 game_key + event_ts < cutoff
 * - 集合名是字符串字面量，不是动态拼接
 * - 第一次跑用 dryRun=true 验证数量
 */
export async function cleanExpiredEvents(options: CleanupOptions = {}): Promise<CleanupSummary> {
  const startedAt = Date.now();
  const retentionDaysLocal = Number.isFinite(options.retentionDaysLocal)
    ? Number(options.retentionDaysLocal)
    : DEFAULT_RETENTION_DAYS_LOCAL;
  const retentionDaysCloud = Number.isFinite(options.retentionDaysCloud)
    ? Number(options.retentionDaysCloud)
    : DEFAULT_RETENTION_DAYS_CLOUD;
  const dryRun = options.dryRun === true;
  const triggerSource = options.triggerSource || 'cron';

  // D1/D7 留存依赖至少 7 天的事件流；本地保留期硬下限 14 天兜底。
  if (retentionDaysLocal < 14) {
    throw new Error(
      `[cleanup] retentionDaysLocal=${retentionDaysLocal} < 14 days, refused (retention 计算需要)`,
    );
  }
  if (retentionDaysCloud < 1) {
    throw new Error(`[cleanup] retentionDaysCloud=${retentionDaysCloud} < 1 day, refused`);
  }

  const cutoffLocalMs = Date.now() - retentionDaysLocal * 86400_000;
  const cutoffCloudMs = Date.now() - retentionDaysCloud * 86400_000;

  const summary: CleanupSummary = {
    retentionDaysLocal,
    retentionDaysCloud,
    cutoffLocalMs,
    cutoffCloudMs,
    localDeleted: 0,
    cloudDeleted: 0,
    cloudErrors: [],
    dryRun,
    triggerSource,
    durationMs: 0,
  };

  // ── 本地 MySQL ──
  // 白名单守卫（即使表名是写死的，也走一遍断言，便于以后误改时立刻报错）
  assertWhitelisted('analytics_events', 'local-mysql');
  try {
    if (dryRun) {
      summary.localDeleted = await countOldEvents(retentionDaysLocal * 86400_000);
    } else {
      summary.localDeleted = await deleteOldEvents(retentionDaysLocal * 86400_000);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    summary.cloudErrors.push(`local: ${msg}`);
  }

  // ── 云端 CloudDB ──
  const secretId = process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '';
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '';
  if (!secretId || !secretKey) {
    summary.cloudErrors.push('skip cloud cleanup: missing TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY');
  } else {
    const sessionToken = process.env.TENCENTCLOUD_SESSION_TOKEN || process.env.TENCENTCLOUD_TOKEN || '';

    for (const game of ANALYTICS_GAMES) {
      try {
        // 白名单守卫：每个游戏循环都校验一次集合名，性能可忽略
        assertWhitelisted(ANALYTICS_EVENTS_COLLECTION, `cloud-${game.gameKey}`);

        const app = tcb.init({
          env: game.cloudEnv,
          secretId,
          secretKey,
          sessionToken: sessionToken || undefined,
        });
        const db = app.database();
        const _ = db.command;

        if (dryRun) {
          // dry-run：只 count，不删；CloudBase count 走 limit-less，量大时也别太担心
          const res = await db
            .collection(ANALYTICS_EVENTS_COLLECTION)
            .where({ game_key: game.gameKey, event_ts: _.lt(cutoffCloudMs) })
            .count();
          summary.cloudDeleted += Number((res && (res as { total?: number }).total) || 0);
          continue;
        }

        let removedThisGame = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // 单游戏单次硬上限：超过 50 万条留给次日 cron 接力，避免一口气跑 1 小时
          if (removedThisGame >= CLOUD_MAX_DELETE_PER_GAME_PER_RUN) {
            summary.cloudErrors.push(
              `${game.gameKey}: hit per-game cap ${CLOUD_MAX_DELETE_PER_GAME_PER_RUN}, will continue next run`,
            );
            break;
          }
          const res = await db
            .collection(ANALYTICS_EVENTS_COLLECTION)
            .where({ game_key: game.gameKey, event_ts: _.lt(cutoffCloudMs) })
            .limit(CLOUD_BATCH_SIZE)
            .remove();
          const removed = Number((res && (res as { deleted?: number }).deleted) || 0);
          removedThisGame += removed;
          summary.cloudDeleted += removed;
          if (removed < CLOUD_BATCH_SIZE) break;
          // 限速：避免连续高频调用触发 CloudBase 单分钟 API 上限
          await sleep(CLOUD_BATCH_SLEEP_MS);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        summary.cloudErrors.push(`${game.gameKey}: ${msg}`);
      }
    }
  }

  const finishedAt = Date.now();
  summary.durationMs = finishedAt - startedAt;

  // 入库历史；包括 dry-run 也落表，便于回看「过去几次预演 vs 真删」
  const status: CleanupRunRecord['status'] =
    summary.cloudErrors.length === 0
      ? 'success'
      : summary.localDeleted === 0 && summary.cloudDeleted === 0
      ? 'failed'
      : 'partial';
  try {
    await recordCleanupRun({
      startedAt,
      finishedAt,
      triggerSource,
      dryRun,
      retentionDaysLocal,
      retentionDaysCloud,
      cutoffLocalMs,
      cutoffCloudMs,
      localDeleted: summary.localDeleted,
      cloudDeleted: summary.cloudDeleted,
      cloudErrors: summary.cloudErrors,
      status,
    });
  } catch (error) {
    // 记录失败不能影响清理任务本身的结果汇报
    console.warn('[cleanup] recordCleanupRun failed:', error);
  }

  return summary;
}

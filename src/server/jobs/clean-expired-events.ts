import tcb from '@cloudbase/node-sdk';

import { ANALYTICS_EVENTS_COLLECTION, ANALYTICS_GAMES } from '../config/analytics-games';
import { deleteOldEvents } from '../analytics-db';

const DEFAULT_RETENTION_DAYS = 30;

interface CleanupSummary {
  retentionDays: number;
  cutoffMs: number;
  localDeleted: number;
  cloudDeleted: number;
  cloudErrors: string[];
}

/**
 * 兜底清理：当 CloudDB 的 TTL 索引未生效或建错时，本 cron 每天定时跑一次。
 * - 本地（SQLite/MySQL）：直接 DELETE 老事件，本地永久库聚合早就跑完，删了不丢分析能力
 * - CloudDB：分游戏调用 db.collection.where(...).remove() 删除超过保留期的事件
 *
 * CloudDB 的 .remove() 单批最多 1000 条，所以循环删；如果 TTL 索引正常工作，这里调用基本是 noop。
 */
export async function cleanExpiredEvents(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<CleanupSummary> {
  const expireMs = retentionDays * 24 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - expireMs;
  const summary: CleanupSummary = {
    retentionDays,
    cutoffMs,
    localDeleted: 0,
    cloudDeleted: 0,
    cloudErrors: [],
  };

  try {
    summary.localDeleted = await deleteOldEvents(expireMs);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    summary.cloudErrors.push(`local-delete failed: ${msg}`);
  }

  const secretId = process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '';
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '';
  if (!secretId || !secretKey) {
    summary.cloudErrors.push('skip cloud cleanup: missing TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY');
    return summary;
  }
  const sessionToken = process.env.TENCENTCLOUD_SESSION_TOKEN || process.env.TENCENTCLOUD_TOKEN || '';

  for (const game of ANALYTICS_GAMES) {
    try {
      const app = tcb.init({
        env: game.cloudEnv,
        secretId,
        secretKey,
        sessionToken: sessionToken || undefined,
      });
      const db = app.database();
      const _ = db.command;
      // 单次 .remove() 上限通常 1000，循环删直到无可删
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await db
          .collection(ANALYTICS_EVENTS_COLLECTION)
          .where({ game_key: game.gameKey, event_ts: _.lt(cutoffMs) })
          .limit(1000)
          .remove();
        const removed = (res && res.deleted) || 0;
        summary.cloudDeleted += removed;
        if (removed < 1000) break;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      summary.cloudErrors.push(`${game.gameKey}: ${msg}`);
    }
  }

  return summary;
}

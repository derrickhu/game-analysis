import { isMysqlMode, getDb, getMysqlPool } from '../db';
import { estimateRevenueCny, getEstimatedEcpm } from '../config/ecpm';
import { BUCKET_SIZE_MS, bucketToTs, tsToBucket } from './bucket';

const AD_EVENT_NAMES = ['ad_request', 'ad_show', 'ad_click', 'ad_close', 'ad_error'] as const;
type AdEventName = (typeof AD_EVENT_NAMES)[number];

/**
 * 实时广告 bucket 聚合
 * - 桶粒度由 metrics/bucket.ts 集中配置（当前 5 分钟）
 * - 实时性：客户端 batcher 默认 15s flush + 云函数 + cron 5min，端到端最坏 ~5 分钟延迟，对广告业务足够细
 * - 容量：1 小时 12 个 bucket，30 天 8640 行/游戏，比 1 分钟粒度小 5 倍
 * - 表名仍然叫 analytics_ad_minute（保留 schema 兼容性），minute_bucket 字符串严格落在 5 分钟整点
 */

interface AdAggregateBucket {
  game_key: string;
  minute_bucket: string;
  ad_type: string;
  scene: string;
  ad_request_cnt: number;
  ad_show_cnt: number;
  ad_click_cnt: number;
  ad_complete_cnt: number;
  ad_error_cnt: number;
}

// 旧实现已迁移到 metrics/bucket.ts 的 tsToBucket，此处保留一个本地别名以减少改动面积
const toMinuteBucket = tsToBucket;

/**
 * 重新计算指定 game_key 在 [fromTs, toTs] 时间段内的分钟桶广告聚合。
 * - 在 ingest-events 之后调用，参数是本批事件的最早/最晚 event_ts
 * - 为了保证幂等，对涉及到的所有 minute_bucket 整体重算（先 DELETE 再 INSERT），不做增量加法
 * - 返回新写入的桶行数
 */
export async function recomputeRealtimeAdMinute(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<number> {
  // 仅当 toTs 明显小于 fromTs（明显的逆序异常输入）或 fromTs 非法时才跳过；
  // 单条事件时 fromTs===toTs 是合法场景，需要继续走完聚合逻辑生成那一桶的数据
  if (fromTs <= 0 || toTs < fromTs) return 0;
  // 涉及的 bucket 范围（前后再各扩 1 个桶宽避免边界丢漏）
  const minuteFrom = toMinuteBucket(Math.max(0, fromTs - BUCKET_SIZE_MS));
  const minuteTo = toMinuteBucket(toTs + BUCKET_SIZE_MS);

  const buckets = await aggregateBuckets(gameKey, minuteFrom, minuteTo);
  await replaceBuckets(gameKey, minuteFrom, minuteTo, buckets);
  return buckets.length;
}

async function aggregateBuckets(
  gameKey: string,
  minuteFrom: string,
  minuteTo: string,
): Promise<AdAggregateBucket[]> {
  // 把 bucket 字符串还原成时间戳上下界（左闭右闭：fromTs 为桶起点，toTs 为该桶终点）
  const fromTs = bucketToTs(minuteFrom);
  const toTs = bucketToTs(minuteTo) + BUCKET_SIZE_MS - 1;

  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const placeholders = AD_EVENT_NAMES.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT event_name, event_ts, params_json
         FROM analytics_events
        WHERE game_key = ?
          AND event_name IN (${placeholders})
          AND event_ts >= ? AND event_ts <= ?`,
      [gameKey, ...AD_EVENT_NAMES, fromTs, toTs],
    );
    return reduceRowsToBuckets(gameKey, rows as Array<{ event_name: string; event_ts: number; params_json: string }>);
  }
  const db = getDb();
  const placeholders = AD_EVENT_NAMES.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT event_name, event_ts, params_json
         FROM analytics_events
        WHERE game_key = ?
          AND event_name IN (${placeholders})
          AND event_ts >= ? AND event_ts <= ?`,
    )
    .all(gameKey, ...AD_EVENT_NAMES, fromTs, toTs) as Array<{
      event_name: string;
      event_ts: number;
      params_json: string;
    }>;
  return reduceRowsToBuckets(gameKey, rows);
}

function reduceRowsToBuckets(
  gameKey: string,
  rows: Array<{ event_name: string; event_ts: number; params_json: string }>,
): AdAggregateBucket[] {
  const map = new Map<string, AdAggregateBucket>();

  for (const row of rows) {
    const bucket = toMinuteBucket(row.event_ts);
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(row.params_json) || {};
    } catch {
      params = {};
    }
    const adType = String(params.ad_type || 'unknown');
    const scene = String(params.scene || 'unknown');
    const key = `${bucket}|${adType}|${scene}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        game_key: gameKey,
        minute_bucket: bucket,
        ad_type: adType,
        scene,
        ad_request_cnt: 0,
        ad_show_cnt: 0,
        ad_click_cnt: 0,
        ad_complete_cnt: 0,
        ad_error_cnt: 0,
      };
      map.set(key, agg);
    }
    switch (row.event_name as AdEventName) {
      case 'ad_request':
        agg.ad_request_cnt += 1;
        break;
      case 'ad_show':
        agg.ad_show_cnt += 1;
        break;
      case 'ad_click':
        agg.ad_click_cnt += 1;
        break;
      case 'ad_close':
        if (params.completed === true || params.completed === 1 || params.completed === 'true') {
          agg.ad_complete_cnt += 1;
        }
        break;
      case 'ad_error':
        agg.ad_error_cnt += 1;
        break;
    }
  }

  return Array.from(map.values());
}

async function replaceBuckets(
  gameKey: string,
  minuteFrom: string,
  minuteTo: string,
  buckets: AdAggregateBucket[],
): Promise<void> {
  const updatedAt = Date.now();
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    await pool.query(
      `DELETE FROM analytics_ad_minute
        WHERE game_key = ? AND minute_bucket >= ? AND minute_bucket <= ?`,
      [gameKey, minuteFrom, minuteTo],
    );
    if (buckets.length === 0) return;
    const cols = [
      'game_key', 'minute_bucket', 'ad_type', 'scene',
      'ad_request_cnt', 'ad_show_cnt', 'ad_click_cnt', 'ad_complete_cnt', 'ad_error_cnt',
      'ecpm_used', 'ad_revenue_estimated_cny', 'updated_at',
    ];
    const placeholders = `(${cols.map(() => '?').join(',')})`;
    const values: unknown[] = [];
    for (const b of buckets) {
      const ecpm = getEstimatedEcpm(b.game_key, b.ad_type, b.scene);
      const revenue = estimateRevenueCny(b.ad_show_cnt, ecpm);
      values.push(
        b.game_key, b.minute_bucket, b.ad_type, b.scene,
        b.ad_request_cnt, b.ad_show_cnt, b.ad_click_cnt, b.ad_complete_cnt, b.ad_error_cnt,
        ecpm, revenue, updatedAt,
      );
    }
    const sql = `INSERT INTO analytics_ad_minute (${cols.join(',')}) VALUES ${buckets.map(() => placeholders).join(',')}`;
    await pool.query(sql, values);
    return;
  }
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM analytics_ad_minute
        WHERE game_key = ? AND minute_bucket >= ? AND minute_bucket <= ?`,
    ).run(gameKey, minuteFrom, minuteTo);
    if (buckets.length === 0) return;
    const stmt = db.prepare(
      `INSERT INTO analytics_ad_minute (
         game_key, minute_bucket, ad_type, scene,
         ad_request_cnt, ad_show_cnt, ad_click_cnt, ad_complete_cnt, ad_error_cnt,
         ecpm_used, ad_revenue_estimated_cny, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const b of buckets) {
      const ecpm = getEstimatedEcpm(b.game_key, b.ad_type, b.scene);
      const revenue = estimateRevenueCny(b.ad_show_cnt, ecpm);
      stmt.run(
        b.game_key, b.minute_bucket, b.ad_type, b.scene,
        b.ad_request_cnt, b.ad_show_cnt, b.ad_click_cnt, b.ad_complete_cnt, b.ad_error_cnt,
        ecpm, revenue, updatedAt,
      );
    }
  });
  tx();
}

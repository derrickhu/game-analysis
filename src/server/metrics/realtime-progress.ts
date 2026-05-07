import { getDb, getMysqlPool, isMysqlMode } from '../db';
import { BUCKET_SIZE_MS, bucketToTs, tsToBucket } from './bucket';

/**
 * 关卡进度看板（hot-pot 专属）
 *
 * 数据源：analytics_events 中的 level_start / level_clear / level_fail 事件
 * 事件 params 字段约定（与 hot-pot/src/scenes/BowlScene.ts 中 track 调用对齐）：
 *   - level_id: number      第几关，从 1 起算
 *   - level_name: string    关卡显示名
 *   - duration_ms: number   通关 / 失败耗时
 *   - orders_remaining: number 失败时还剩多少订单未完成
 *
 * 核心指标：
 *   - 总尝试次数 / 总通关次数 / 总放弃次数
 *   - 全服最高解锁关卡（max(level_id) where level_clear）
 *   - 关卡分布：每关有多少独立用户尝试过、多少用户通关、放弃，以及通关率
 *   - 时间序列（5 分钟桶）：level_clear / level_fail 数量
 *
 * 关卡是 hot-pot 的核心进度指标，前端会用「独立模块」展示，不与活跃 / 广告混合。
 */

const LEVEL_EVENTS = ['level_start', 'level_clear', 'level_fail'] as const;
type LevelEventName = (typeof LEVEL_EVENTS)[number];

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";

export interface ProgressKpi {
  total_starts: number;
  total_clears: number;
  total_fails: number;
  /** 全服最高已通关关卡（迄今所有 level_clear 中最大的 level_id），用作进度天花板 */
  max_cleared_level: number;
  /** 平均通关耗时（毫秒），按 level_clear.duration_ms 平均 */
  avg_clear_duration_ms: number;
  /** 通关率 = 通关次数 / 开始次数 */
  clear_rate: number | null;
  computed_at: number;
}

export interface LevelDistributionRow {
  level_id: number;
  start_users: number;   // 尝试这一关的去重用户数
  clear_users: number;   // 通关这一关的去重用户数
  fail_users: number;    // 在这一关放弃的去重用户数
  pass_rate: number | null; // = clear_users / start_users
}

export interface ProgressSeriesPoint {
  bucket: string;
  ts: number;
  start_cnt: number;
  clear_cnt: number;
  fail_cnt: number;
}

export interface ProgressResult {
  kpi: ProgressKpi;
  distribution: LevelDistributionRow[];
  series: ProgressSeriesPoint[];
}

export async function getProgressOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<ProgressResult> {
  const [kpi, distribution, series] = await Promise.all([
    computeKpi(gameKey),
    computeDistribution(gameKey),
    computeSeries(gameKey, fromTs, toTs),
  ]);
  return { kpi, distribution, series };
}

async function computeKpi(gameKey: string): Promise<ProgressKpi> {
  const counts = await countLevelEvents(gameKey);
  const maxLevel = await getMaxClearedLevel(gameKey);
  const avgDuration = await getAvgClearDuration(gameKey);
  const totalStarts = counts.level_start;
  const totalClears = counts.level_clear;
  const totalFails = counts.level_fail;
  return {
    total_starts: totalStarts,
    total_clears: totalClears,
    total_fails: totalFails,
    max_cleared_level: maxLevel,
    avg_clear_duration_ms: avgDuration,
    clear_rate: totalStarts > 0 ? totalClears / totalStarts : null,
    computed_at: Date.now(),
  };
}

async function countLevelEvents(gameKey: string): Promise<Record<LevelEventName, number>> {
  const out: Record<LevelEventName, number> = {
    level_start: 0,
    level_clear: 0,
    level_fail: 0,
  };
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT event_name, COUNT(*) AS c
         FROM analytics_events
        WHERE game_key = ? AND event_name IN ('level_start','level_clear','level_fail')
        GROUP BY event_name`,
      [gameKey],
    );
    for (const r of rows as Array<{ event_name: LevelEventName; c: number }>) {
      out[r.event_name] = Number(r.c);
    }
    return out;
  }
  const rows = getDb()
    .prepare(
      `SELECT event_name, COUNT(*) AS c
         FROM analytics_events
        WHERE game_key = ? AND event_name IN ('level_start','level_clear','level_fail')
        GROUP BY event_name`,
    )
    .all(gameKey) as Array<{ event_name: LevelEventName; c: number }>;
  for (const r of rows) {
    out[r.event_name] = Number(r.c);
  }
  return out;
}

async function getMaxClearedLevel(gameKey: string): Promise<number> {
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT MAX(CAST(JSON_EXTRACT(params_json, '$.level_id') AS UNSIGNED)) AS max_lv
         FROM analytics_events
        WHERE game_key = ? AND event_name = 'level_clear'`,
      [gameKey],
    );
    const v = (rows as Array<{ max_lv: number | null }>)[0]?.max_lv;
    return Number(v || 0);
  }
  // sqlite 用 json_extract（better-sqlite3 默认编译带 JSON1）
  const r = getDb()
    .prepare(
      `SELECT MAX(CAST(json_extract(params_json, '$.level_id') AS INTEGER)) AS max_lv
         FROM analytics_events
        WHERE game_key = ? AND event_name = 'level_clear'`,
    )
    .get(gameKey) as { max_lv: number | null };
  return Number(r?.max_lv || 0);
}

async function getAvgClearDuration(gameKey: string): Promise<number> {
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT AVG(CAST(JSON_EXTRACT(params_json, '$.duration_ms') AS UNSIGNED)) AS avg_d
         FROM analytics_events
        WHERE game_key = ? AND event_name = 'level_clear'`,
      [gameKey],
    );
    const v = (rows as Array<{ avg_d: number | null }>)[0]?.avg_d;
    return Math.round(Number(v || 0));
  }
  const r = getDb()
    .prepare(
      `SELECT AVG(CAST(json_extract(params_json, '$.duration_ms') AS INTEGER)) AS avg_d
         FROM analytics_events
        WHERE game_key = ? AND event_name = 'level_clear'`,
    )
    .get(gameKey) as { avg_d: number | null };
  return Math.round(Number(r?.avg_d || 0));
}

/**
 * 关卡分布：每关有多少独立用户「尝试 / 通关 / 放弃」。
 * 实现：同时拉 level_start / level_clear / level_fail，按 level_id + user_key 去重，再做 outer join 风格合并。
 */
async function computeDistribution(gameKey: string): Promise<LevelDistributionRow[]> {
  const [startMap, clearMap, failMap] = await Promise.all([
    listLevelUserSet(gameKey, 'level_start'),
    listLevelUserSet(gameKey, 'level_clear'),
    listLevelUserSet(gameKey, 'level_fail'),
  ]);
  const allLevels = new Set<number>();
  for (const m of [startMap, clearMap, failMap]) {
    for (const k of m.keys()) allLevels.add(k);
  }
  const out: LevelDistributionRow[] = [];
  for (const lv of Array.from(allLevels).sort((a, b) => a - b)) {
    const start_users = startMap.get(lv)?.size || 0;
    const clear_users = clearMap.get(lv)?.size || 0;
    const fail_users = failMap.get(lv)?.size || 0;
    out.push({
      level_id: lv,
      start_users,
      clear_users,
      fail_users,
      pass_rate: start_users > 0 ? clear_users / start_users : null,
    });
  }
  return out;
}

async function listLevelUserSet(
  gameKey: string,
  eventName: LevelEventName,
): Promise<Map<number, Set<string>>> {
  const map = new Map<number, Set<string>>();
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT
         CAST(JSON_EXTRACT(params_json, '$.level_id') AS SIGNED) AS level_id,
         ${USER_KEY_SQL} AS uk
       FROM analytics_events
       WHERE game_key = ? AND event_name = ?`,
      [gameKey, eventName],
    );
    for (const r of rows as Array<{ level_id: number; uk: string }>) {
      const lv = Number(r.level_id);
      if (!Number.isFinite(lv) || lv <= 0) continue;
      if (!map.has(lv)) map.set(lv, new Set());
      map.get(lv)!.add(r.uk);
    }
    return map;
  }
  const rows = getDb()
    .prepare(
      `SELECT
         CAST(json_extract(params_json, '$.level_id') AS INTEGER) AS level_id,
         ${USER_KEY_SQL} AS uk
       FROM analytics_events
       WHERE game_key = ? AND event_name = ?`,
    )
    .all(gameKey, eventName) as Array<{ level_id: number | null; uk: string }>;
  for (const r of rows) {
    const lv = Number(r.level_id);
    if (!Number.isFinite(lv) || lv <= 0) continue;
    if (!map.has(lv)) map.set(lv, new Set());
    map.get(lv)!.add(r.uk);
  }
  return map;
}

async function computeSeries(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<ProgressSeriesPoint[]> {
  if (toTs < fromTs) return [];
  const startCounts = await countByBucket(gameKey, 'level_start', fromTs, toTs);
  const clearCounts = await countByBucket(gameKey, 'level_clear', fromTs, toTs);
  const failCounts = await countByBucket(gameKey, 'level_fail', fromTs, toTs);
  const startBucketTs = bucketToTs(tsToBucket(fromTs));
  const endBucketTs = bucketToTs(tsToBucket(toTs));
  const out: ProgressSeriesPoint[] = [];
  for (let ts = startBucketTs; ts <= endBucketTs; ts += BUCKET_SIZE_MS) {
    const bucket = tsToBucket(ts);
    out.push({
      bucket,
      ts,
      start_cnt: startCounts.get(bucket) || 0,
      clear_cnt: clearCounts.get(bucket) || 0,
      fail_cnt: failCounts.get(bucket) || 0,
    });
  }
  return out;
}

async function countByBucket(
  gameKey: string,
  eventName: LevelEventName,
  fromTs: number,
  toTs: number,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let rows: Array<{ event_ts: number }>;
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [r] = await pool.query(
      `SELECT event_ts FROM analytics_events
        WHERE game_key = ? AND event_name = ?
          AND event_ts BETWEEN ? AND ?`,
      [gameKey, eventName, fromTs, toTs],
    );
    rows = r as Array<{ event_ts: number }>;
  } else {
    rows = getDb()
      .prepare(
        `SELECT event_ts FROM analytics_events
          WHERE game_key = ? AND event_name = ?
            AND event_ts BETWEEN ? AND ?`,
      )
      .all(gameKey, eventName, fromTs, toTs) as Array<{ event_ts: number }>;
  }
  for (const r of rows) {
    const bucket = tsToBucket(Number(r.event_ts));
    map.set(bucket, (map.get(bucket) || 0) + 1);
  }
  return map;
}

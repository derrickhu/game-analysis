import { getDb, getMysqlPool, isMysqlMode } from '../db';
import { BUCKET_SIZE_MS, bucketToTs, tsToBucket } from './bucket';
import { PLATFORM_SQL, platformSqlParams } from './platform-filter';

/**
 * 实时综合看板（DAU / 新增 / 留存 / 活跃趋势）
 *
 * 设计原则：
 * - 完全基于 analytics_events 流水表实时聚合（5 分钟桶），不做中间汇总表
 * - events 表 30 天 TTL，单游戏每天 ~ 几万行（按当前数据量），实时 SQL 完全够
 * - 用户身份归一：优先 user_id（业务侧 openid），为空时降级到 anonymous_id
 *   这样可以避免「未登录前」的 anonymous 用户被错误丢失
 * - DAU 统计基于 session_start 事件（这是入会唯一可信入口）；
 *   时间序列里的 active_users 也用 session_start，避免广告/关卡事件夹带
 */

/** 用户身份归一：以 user_id 为主，空串则用 anonymous_id 兜底 */
const USER_KEY_SQL_SQLITE = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
const USER_KEY_SQL_MYSQL = USER_KEY_SQL_SQLITE; // 两者语法一致

const SESSION_START = 'session_start';
export interface OverviewKpi {
  /** 当前时间窗口内 session_start 去重用户数（窗口=今日时即为今日 DAU；选历史日时即为该日 DAU；多日窗口为窗口内活跃合计） */
  dau: number;
  /** 窗口结束时刻往前 1 小时的活跃用户数（窗口=today 时与"现在"重合；历史窗口看的是该窗口结束前最后 1 小时） */
  active_users_1h: number;
  /** 在全表中首次 session_start 于当前时间窗口内的去重用户数 */
  new_users_today: number;
  /** 次日留存率：锚点日前 1 日新增 cohort ∩ 锚点日 session_start / 锚点日前 1 日新增 cohort */
  retention_d1_rate: number | null;
  /** 次留 cohort（分母）：锚点日前 1 日首次 session_start 的去重用户数 */
  retention_d1_cohort: number;
  /** 次留回访（分子）：cohort 中锚点日仍有 session_start 的去重用户数 */
  retention_d1_returned: number;
  /** 锚点日前 1 日的本地 YYYY-MM-DD（cohort 所在日） */
  retention_d1_cohort_date: string;
  /** 7 日留存率：锚点日前 7 日 cohort ∩ 锚点日有事件 / 锚点日前 7 日 cohort */
  retention_d7_rate: number | null;
  /** 7 留 cohort（分母）：锚点日前 7 日首次 session_start 的去重用户数 */
  retention_d7_cohort: number;
  /** 7 留回访（分子）：cohort 中锚点日仍有 session_start 的去重用户数 */
  retention_d7_returned: number;
  /** 锚点日前 7 日的本地 YYYY-MM-DD */
  retention_d7_cohort_date: string;
  /** 锚点日的本地 YYYY-MM-DD（= 当前时间窗口结束日所在的自然日） */
  retention_anchor_date: string;
  /** 计算时刻：查询点的 ms 时间戳 */
  computed_at: number;
}

interface CohortStat {
  /** 分母：cohort 中的去重用户数 */
  cohort: number;
  /** 分子：cohort 中锚点日仍有 session_start 的去重用户数 */
  retain: number;
  /** 比例：cohort 为 0 时为 null（无法算） */
  rate: number | null;
}

export interface OverviewSeriesPoint {
  bucket: string;       // 5 分钟桶字符串（与 ad-revenue 同口径）
  ts: number;           // 桶起点 ms
  active_users: number; // 该桶内 session_start 去重用户数（≈每 5min 活跃）
  new_users: number;    // 该桶内首次 session_start 的用户数（按全表历史判断）
}

export interface OverviewResult {
  kpi: OverviewKpi;
  series: OverviewSeriesPoint[];
}

/**
 * 一次性算出所选时间窗口内的 KPI + 时间序列。
 * @param gameKey - 游戏 key
 * @param fromTs - 序列起点 ms（包含）
 * @param toTs - 序列终点 ms（包含）
 */
export async function getOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<OverviewResult> {
  const now = Date.now();
  // 锚点日 = 窗口结束日所在的本地自然日（YYYY-MM-DD）
  // 留存口径在用户切窗口时跟着移动，比如选 5/8 一整天 → 锚点日=5/8，D1 cohort=5/7、D1 retain=5/8
  const anchorDayStart = startOfDay(toTs);
  const anchorDayEnd = anchorDayStart + 86_400_000 - 1;
  const d1CohortStart = anchorDayStart - 86_400_000;
  const d1CohortEnd = anchorDayStart - 1;
  const d7CohortStart = anchorDayStart - 7 * 86_400_000;
  const d7CohortEnd = d7CohortStart + 86_400_000 - 1;
  // "近 1 小时活跃" 锚到窗口结束时刻，窗口很短时与起点取较大值，避免越过 fromTs
  const oneHourFrom = Math.max(toTs - 3_600_000, fromTs);

  // 并行计算各 KPI（SQLite 是同步驱动，所以并行收益很小，但代码组织上更清晰）
  const [dau, active1h, newInWindow, retentionD1, retentionD7] = await Promise.all([
    countDistinctUsers(gameKey, fromTs, toTs, SESSION_START, platform),
    countDistinctUsers(gameKey, oneHourFrom, toTs, undefined, platform), // 任意事件都算活跃
    countNewUsersInWindow(gameKey, fromTs, toTs, platform),
    cohortRetention(gameKey, d1CohortStart, d1CohortEnd, anchorDayStart, anchorDayEnd, platform),
    cohortRetention(gameKey, d7CohortStart, d7CohortEnd, anchorDayStart, anchorDayEnd, platform),
  ]);

  const series = await getActiveSeries(gameKey, fromTs, toTs, platform);

  return {
    kpi: {
      dau,
      active_users_1h: active1h,
      new_users_today: newInWindow,
      retention_d1_rate: retentionD1.rate,
      retention_d1_cohort: retentionD1.cohort,
      retention_d1_returned: retentionD1.retain,
      retention_d1_cohort_date: formatLocalDate(d1CohortStart),
      retention_d7_rate: retentionD7.rate,
      retention_d7_cohort: retentionD7.cohort,
      retention_d7_returned: retentionD7.retain,
      retention_d7_cohort_date: formatLocalDate(d7CohortStart),
      retention_anchor_date: formatLocalDate(anchorDayStart),
      computed_at: now,
    },
    series,
  };
}

/** 在 [fromTs,toTs] 窗口内，按事件名（可选）的去重用户数 */
async function countDistinctUsers(
  gameKey: string,
  fromTs: number,
  toTs: number,
  eventName?: string,
  platform?: string,
): Promise<number> {
  if (toTs < fromTs) return 0;
  const platformParams = platformSqlParams(platform);
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const sql = eventName
      ? `SELECT COUNT(DISTINCT ${USER_KEY_SQL_MYSQL}) AS c
           FROM analytics_events
          WHERE game_key = ? AND event_ts BETWEEN ? AND ?
            AND event_name = ?${PLATFORM_SQL}`
      : `SELECT COUNT(DISTINCT ${USER_KEY_SQL_MYSQL}) AS c
           FROM analytics_events
          WHERE game_key = ? AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`;
    const params = eventName
      ? [gameKey, fromTs, toTs, eventName, ...platformParams]
      : [gameKey, fromTs, toTs, ...platformParams];
    const [rows] = await pool.query(sql, params);
    return Number((rows as Array<{ c: number }>)[0]?.c || 0);
  }
  const db = getDb();
  if (eventName) {
    const r = db
      .prepare(
        `SELECT COUNT(DISTINCT ${USER_KEY_SQL_SQLITE}) AS c
           FROM analytics_events
          WHERE game_key = ? AND event_ts BETWEEN ? AND ?
            AND event_name = ?${PLATFORM_SQL}`,
      )
      .get(gameKey, fromTs, toTs, eventName, ...platformParams) as { c: number };
    return Number(r?.c || 0);
  }
  const r = db
    .prepare(
      `SELECT COUNT(DISTINCT ${USER_KEY_SQL_SQLITE}) AS c
         FROM analytics_events
        WHERE game_key = ? AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`,
    )
    .get(gameKey, fromTs, toTs, ...platformParams) as { c: number };
  return Number(r?.c || 0);
}

/**
 * 在 [fromTs,toTs] 窗口内首次 session_start 的去重用户数。
 * 注意新增、DAU、留存都用 session_start 作为进入游戏口径，避免任意事件把分母/分子撑大。
 */
export async function countNewUsersInWindow(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<number> {
  if (toTs < fromTs) return 0;
  const platformParams = platformSqlParams(platform);
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS c FROM (
         SELECT ${USER_KEY_SQL_MYSQL} AS uk, MIN(event_ts) AS first_ts
           FROM analytics_events
          WHERE game_key = ?
            AND event_name = ?${PLATFORM_SQL}
          GROUP BY ${USER_KEY_SQL_MYSQL}
       ) t WHERE t.first_ts BETWEEN ? AND ?`,
      [gameKey, SESSION_START, ...platformParams, fromTs, toTs],
    );
    return Number((rows as Array<{ c: number }>)[0]?.c || 0);
  }
  const r = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT ${USER_KEY_SQL_SQLITE} AS uk, MIN(event_ts) AS first_ts
           FROM analytics_events
          WHERE game_key = ?
            AND event_name = ?${PLATFORM_SQL}
          GROUP BY ${USER_KEY_SQL_SQLITE}
       ) t WHERE t.first_ts BETWEEN ? AND ?`,
    )
    .get(gameKey, SESSION_START, ...platformParams, fromTs, toTs) as { c: number };
  return Number(r?.c || 0);
}

/**
 * 计算新增 cohort 留存：分母是 baseFrom..baseTo 内首次 session_start 的用户，
 * 分子是这批用户在 retainFrom..retainTo 内仍有 session_start 的人数。
 * 返回三元组：cohort（分母）、retain（分子）、rate（cohort=0 时为 null）。
 */
async function cohortRetention(
  gameKey: string,
  baseFrom: number,
  baseTo: number,
  retainFrom: number,
  retainTo: number,
  platform?: string,
): Promise<CohortStat> {
  const empty: CohortStat = { cohort: 0, retain: 0, rate: null };
  if (baseTo < baseFrom || retainTo < retainFrom) return empty;
  const platformParams = platformSqlParams(platform);
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT
         COUNT(DISTINCT base.uk) AS base_cnt,
         COUNT(DISTINCT CASE WHEN ret.uk IS NOT NULL THEN base.uk END) AS retain_cnt
       FROM (
         SELECT ${USER_KEY_SQL_MYSQL} AS uk, MIN(event_ts) AS first_ts
           FROM analytics_events
          WHERE game_key = ?
            AND event_name = ?${PLATFORM_SQL}
          GROUP BY ${USER_KEY_SQL_MYSQL}
         HAVING first_ts BETWEEN ? AND ?
       ) base
       LEFT JOIN (
         SELECT DISTINCT ${USER_KEY_SQL_MYSQL} AS uk
           FROM analytics_events
          WHERE game_key = ?
            AND event_name = ?
            AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}
       ) ret ON base.uk = ret.uk`,
      [
        gameKey,
        SESSION_START,
        ...platformParams,
        baseFrom,
        baseTo,
        gameKey,
        SESSION_START,
        retainFrom,
        retainTo,
        ...platformParams,
      ],
    );
    const row = (rows as Array<{ base_cnt: number; retain_cnt: number }>)[0];
    const cohort = Number(row?.base_cnt || 0);
    const retain = Number(row?.retain_cnt || 0);
    return { cohort, retain, rate: cohort > 0 ? retain / cohort : null };
  }
  const db = getDb();
  const baseRows = db
    .prepare(
      `SELECT ${USER_KEY_SQL_SQLITE} AS uk, MIN(event_ts) AS first_ts
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?${PLATFORM_SQL}
        GROUP BY ${USER_KEY_SQL_SQLITE}
       HAVING first_ts BETWEEN ? AND ?`,
    )
    .all(gameKey, SESSION_START, ...platformParams, baseFrom, baseTo) as Array<{ uk: string }>;
  if (baseRows.length === 0) return empty;
  const baseSet = new Set(baseRows.map((r) => r.uk));
  const retainRows = db
    .prepare(
      `SELECT DISTINCT ${USER_KEY_SQL_SQLITE} AS uk
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?
          AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`,
    )
    .all(gameKey, SESSION_START, retainFrom, retainTo, ...platformParams) as Array<{ uk: string }>;
  let hit = 0;
  for (const r of retainRows) {
    if (baseSet.has(r.uk)) hit++;
  }
  return { cohort: baseSet.size, retain: hit, rate: hit / baseSet.size };
}

/**
 * 5 分钟桶活跃 / 新增时间序列。
 * - active_users：每个桶内 session_start 去重用户数
 * - new_users：每个桶内「全表首次 session_start」用户数
 *
 * 实现：在内存里按桶分组，桶字符串与 ad-revenue 同口径，方便前端做 x 轴对齐
 */
async function getActiveSeries(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<OverviewSeriesPoint[]> {
  if (toTs < fromTs) return [];
  // 1) 拉窗口内 session_start 事件，按桶去重
  const sessionRows = await listSessionStarts(gameKey, fromTs, toTs, platform);
  // 2) 拉每个用户的全表首次 session_start 时间，给 new_users 计算用
  const firstSeenMap = await getFirstSeenMap(gameKey, platform);

  // 桶 -> Set<uk>
  const activeBuckets = new Map<string, Set<string>>();
  const newUserBuckets = new Map<string, Set<string>>();
  for (const r of sessionRows) {
    const bucket = tsToBucket(r.event_ts);
    if (!activeBuckets.has(bucket)) activeBuckets.set(bucket, new Set());
    activeBuckets.get(bucket)!.add(r.uk);
    const firstTs = firstSeenMap.get(r.uk);
    if (firstTs !== undefined && firstTs >= fromTs && firstTs <= toTs) {
      const newBucket = tsToBucket(firstTs);
      if (!newUserBuckets.has(newBucket)) newUserBuckets.set(newBucket, new Set());
      newUserBuckets.get(newBucket)!.add(r.uk);
    }
  }

  // 生成连续 5 分钟桶（含空桶 0 值）
  const startBucketTs = bucketToTs(tsToBucket(fromTs));
  const endBucketTs = bucketToTs(tsToBucket(toTs));
  const out: OverviewSeriesPoint[] = [];
  for (let ts = startBucketTs; ts <= endBucketTs; ts += BUCKET_SIZE_MS) {
    const bucket = tsToBucket(ts);
    out.push({
      bucket,
      ts,
      active_users: activeBuckets.get(bucket)?.size || 0,
      new_users: newUserBuckets.get(bucket)?.size || 0,
    });
  }
  return out;
}

async function listSessionStarts(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<Array<{ uk: string; event_ts: number }>> {
  const platformParams = platformSqlParams(platform);
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT ${USER_KEY_SQL_MYSQL} AS uk, event_ts
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?
          AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`,
      [gameKey, SESSION_START, fromTs, toTs, ...platformParams],
    );
    return rows as Array<{ uk: string; event_ts: number }>;
  }
  return getDb()
    .prepare(
      `SELECT ${USER_KEY_SQL_SQLITE} AS uk, event_ts
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?
          AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`,
    )
    .all(gameKey, SESSION_START, fromTs, toTs, ...platformParams) as Array<{ uk: string; event_ts: number }>;
}

/**
 * 拉「每个用户的全表最早 session_start」，用于新增用户判定。
 * 用户量小时（数千～几万），全量扫一次完全够用；用户量上 10 万级时再考虑加索引/汇总表。
 */
async function getFirstSeenMap(gameKey: string, platform?: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const platformParams = platformSqlParams(platform);
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT ${USER_KEY_SQL_MYSQL} AS uk, MIN(event_ts) AS first_ts
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?${PLATFORM_SQL}
        GROUP BY ${USER_KEY_SQL_MYSQL}`,
      [gameKey, SESSION_START, ...platformParams],
    );
    for (const r of rows as Array<{ uk: string; first_ts: number }>) {
      map.set(r.uk, Number(r.first_ts));
    }
    return map;
  }
  const rows = getDb()
    .prepare(
      `SELECT ${USER_KEY_SQL_SQLITE} AS uk, MIN(event_ts) AS first_ts
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?${PLATFORM_SQL}
        GROUP BY ${USER_KEY_SQL_SQLITE}`,
    )
    .all(gameKey, SESSION_START, ...platformParams) as Array<{ uk: string; first_ts: number }>;
  for (const r of rows) {
    map.set(r.uk, Number(r.first_ts));
  }
  return map;
}

/** 当地时区今日 0 点 ms */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 把 ms 时间戳格式化成本地时区的 YYYY-MM-DD（cohort 日期展示用） */
function formatLocalDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

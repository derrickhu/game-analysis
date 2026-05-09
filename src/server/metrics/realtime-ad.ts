import { isMysqlMode, getDb, getMysqlPool } from '../db';
import { estimateRevenueCny, getEstimatedEcpm } from '../config/ecpm';
import { BUCKET_SIZE_MS, bucketToTs, tsToBucket, tsToHourBucket } from './bucket';

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

/**
 * 用户视角广告指标（看广告 UAU、DAU、渗透率、人均广告次数、ARPDAU）。
 *
 * 设计取舍：
 * - 直接打 analytics_events 流水去重，避免在 analytics_ad_minute 上加 user_set 列引发的体积膨胀
 * - 派生比例（渗透率/人均/ARPDAU）由调用方传入 totals 直接算出，不重复扫表
 * - DAU 走 session_start 与 realtime-overview 同口径，避免两个看板出不一样的 DAU
 * - 用户身份归一公式 COALESCE(NULLIF(user_id,''), anonymous_id) 与 overview 共用
 */
export interface AdUserMetrics {
  /** 看广告 UAU：当前窗口内 ad_show 事件去重用户数 */
  ad_uau: number;
  /** DAU：当前窗口内 session_start 事件去重用户数（与 overview 同口径） */
  dau: number;
  /** 广告渗透率（%）：ad_uau / dau */
  ad_penetration_rate: number;
  /** 人均广告次数：total_show / ad_uau */
  ad_show_per_uu: number;
  /** 估算 ARPDAU（元）：total_revenue / dau，注意是估算口径，不等于真实结算 */
  arpdau_estimated_cny: number;
}

export async function getAdUserMetrics(
  gameKey: string,
  fromTs: number,
  toTs: number,
  totalShow: number,
  totalRevenue: number,
): Promise<AdUserMetrics> {
  const [adUau, dau] = await Promise.all([
    countDistinctUsersByEvent(gameKey, fromTs, toTs, 'ad_show'),
    countDistinctUsersByEvent(gameKey, fromTs, toTs, 'session_start'),
  ]);
  const adPenetrationRate = dau > 0 ? Math.round((adUau / dau) * 10000) / 100 : 0;
  const adShowPerUu = adUau > 0 ? Math.round((totalShow / adUau) * 100) / 100 : 0;
  const arpdauEstimatedCny = dau > 0 ? Math.round((totalRevenue / dau) * 100) / 100 : 0;
  return {
    ad_uau: adUau,
    dau,
    ad_penetration_rate: adPenetrationRate,
    ad_show_per_uu: adShowPerUu,
    arpdau_estimated_cny: arpdauEstimatedCny,
  };
}

/**
 * 桶级 ad_uau / 在线 UAU：把窗口内全部事件流水扫一次，在 JS 里折成 5 分钟桶 → user_key Set。
 *
 * 为什么桶级分母用「任意事件活跃用户」而不是 session_start：
 * - session_start 仅在会话开始那一桶里出现一次，后续桶即便用户在玩、在看广告，session_start 桶级数量为 0
 * - 这会导致桶级渗透率 = ad_uau / session_start 爆到 100%+ 甚至 200%+（用户已被前面的桶"消化"掉）
 * - 改用「该 5 分钟桶任一事件的去重用户数」作为活跃在线 UAU，分母语义=「这 5 分钟有多少人在线」
 *   ad_uau 必然 ≤ active_uu，渗透率自然 ≤ 100%
 *
 * 注意：窗口级 dau / 渗透率 / ARPDAU（在 KPI 卡里）仍由 getAdUserMetrics 走 session_start 口径，
 *      与 realtime-overview 同口径，避免和总览看板出不一样的 DAU。
 *
 * 为什么用流水折桶而不是 GROUP BY：
 * - SQL 层 5 分钟对齐折桶 SQLite/MySQL 写法差异大；JS 里 tsToBucket 已是统一函数
 * - 当前 24h 窗口下 events 行数在万到几十万级，Map<bucket, Set<uk>> 几 MB 内存即可，单次扫描足够快
 * - 上量后再考虑在 analytics_ad_minute 加 user_set 预聚合列
 */
export interface SeriesUserBuckets {
  /** 5 分钟桶 → 看广告去重用户集合 */
  adUau: Map<string, Set<string>>;
  /** 5 分钟桶 → 在线 UAU 集合 */
  activeUu: Map<string, Set<string>>;
  /** 1 小时桶 → 看广告去重用户集合（与 5 分钟桶用户独立去重，跨桶不重叠） */
  adUauHourly: Map<string, Set<string>>;
  /** 1 小时桶 → 在线 UAU 集合 */
  activeUuHourly: Map<string, Set<string>>;
}

export async function listSeriesUserBuckets(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<SeriesUserBuckets> {
  const adUau = new Map<string, Set<string>>();
  const activeUu = new Map<string, Set<string>>();
  const adUauHourly = new Map<string, Set<string>>();
  const activeUuHourly = new Map<string, Set<string>>();
  if (toTs < fromTs) return { adUau, activeUu, adUauHourly, activeUuHourly };

  const userKeySql = "COALESCE(NULLIF(user_id, ''), anonymous_id) AS uk";
  // 不限制 event_name：每条事件都进 active_uu，ad_show 额外进 ad_uau
  // 一次扫描同时折 5 分钟桶 + 1 小时桶，避免分别扫两遍
  const sql = `SELECT event_ts, event_name, ${userKeySql}
                 FROM analytics_events
                WHERE game_key = ?
                  AND event_ts BETWEEN ? AND ?`;

  const addToSet = (map: Map<string, Set<string>>, key: string, uk: string) => {
    let set = map.get(key);
    if (!set) {
      set = new Set<string>();
      map.set(key, set);
    }
    set.add(uk);
  };

  const onRow = (eventTs: number, eventName: string, uk: string) => {
    if (!uk) return;
    const bucket5m = tsToBucket(eventTs);
    const bucket1h = tsToHourBucket(eventTs);
    addToSet(activeUu, bucket5m, uk);
    addToSet(activeUuHourly, bucket1h, uk);
    if (eventName === 'ad_show') {
      addToSet(adUau, bucket5m, uk);
      addToSet(adUauHourly, bucket1h, uk);
    }
  };

  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(sql, [gameKey, fromTs, toTs]);
    for (const r of rows as Array<{ event_ts: number; event_name: string; uk: string }>) {
      onRow(Number(r.event_ts), String(r.event_name), String(r.uk ?? ''));
    }
  } else {
    const stmt = getDb().prepare(sql);
    for (const r of stmt.iterate(gameKey, fromTs, toTs) as IterableIterator<{
      event_ts: number;
      event_name: string;
      uk: string;
    }>) {
      onRow(Number(r.event_ts), String(r.event_name), String(r.uk ?? ''));
    }
  }
  return { adUau, activeUu, adUauHourly, activeUuHourly };
}

async function countDistinctUsersByEvent(
  gameKey: string,
  fromTs: number,
  toTs: number,
  eventName: string,
): Promise<number> {
  if (toTs < fromTs) return 0;
  // 复用 realtime-overview 同款身份归一表达式：未登录的 anonymous 用户也算入分母，避免人为压低 DAU
  const userKeySql = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT COUNT(DISTINCT ${userKeySql}) AS c
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?
          AND event_ts BETWEEN ? AND ?`,
      [gameKey, eventName, fromTs, toTs],
    );
    return Number((rows as Array<{ c: number }>)[0]?.c || 0);
  }
  const row = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT ${userKeySql}) AS c
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?
          AND event_ts BETWEEN ? AND ?`,
    )
    .get(gameKey, eventName, fromTs, toTs) as { c: number };
  return Number(row?.c || 0);
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
    return reduceRowsToBuckets(gameKey, rows as Array<{ event_name: string; event_ts: number; params_json: string | Record<string, unknown> }>);
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
  rows: Array<{ event_name: string; event_ts: number; params_json: string | Record<string, unknown> }>,
): AdAggregateBucket[] {
  const map = new Map<string, AdAggregateBucket>();

  for (const row of rows) {
    const bucket = toMinuteBucket(row.event_ts);
    let params: Record<string, unknown> = {};
    if (typeof row.params_json === 'string') {
      try {
        params = JSON.parse(row.params_json) || {};
      } catch {
        params = {};
      }
    } else if (row.params_json && typeof row.params_json === 'object') {
      // MySQL JSON 列经 mysql2 读取后可能已经是对象，不能再 JSON.parse，否则会退化成 unknown 聚合。
      params = row.params_json;
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

/**
 * 广告错误明细 Top N。
 *
 * 设计取舍：
 * - 直接扫 analytics_events.params_json，不在 analytics_ad_minute 上加 err_code 维度（会导致桶基数膨胀）
 * - 按 (scene, ad_type, err_code, err_msg) 聚合，便于「单事故」与「持续拒填」一眼区分
 *   - cgi fail 事故：单一 err_msg 集中爆发 → top 1 就是它
 *   - 流量主无填充：err_code=1004 / no advertisement，常态化分布
 * - err_msg 截断到 200 字符避免长堆栈占满 UI
 * - SDK 双发 bug 修复后，err_code 列里 -100/-101 是 SDK 自定义码，其它都是 wx 真实码
 */
export interface AdErrorRow {
  scene: string;
  ad_type: string;
  err_code: string;
  err_msg: string;
  count: number;
  affected_users: number;
  last_seen_ts: number;
}

export async function listAdErrorTopN(
  gameKey: string,
  fromTs: number,
  toTs: number,
  limit = 20,
): Promise<AdErrorRow[]> {
  if (toTs < fromTs) return [];

  const userKeySql = "COALESCE(NULLIF(user_id, ''), anonymous_id)";

  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT
         JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.scene'))   AS scene,
         JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.ad_type')) AS ad_type,
         JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.err_code')) AS err_code,
         SUBSTRING(JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.err_msg')), 1, 200) AS err_msg,
         COUNT(*) AS cnt,
         COUNT(DISTINCT ${userKeySql}) AS users,
         MAX(event_ts) AS last_ts
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = 'ad_error'
          AND event_ts BETWEEN ? AND ?
        GROUP BY scene, ad_type, err_code, err_msg
        ORDER BY cnt DESC
        LIMIT ?`,
      [gameKey, fromTs, toTs, limit],
    );
    return (rows as Array<{
      scene: string | null;
      ad_type: string | null;
      err_code: string | null;
      err_msg: string | null;
      cnt: number;
      users: number;
      last_ts: number;
    }>).map((r) => ({
      scene: r.scene || 'unknown',
      ad_type: r.ad_type || 'unknown',
      err_code: r.err_code != null ? String(r.err_code) : '',
      err_msg: r.err_msg || '',
      count: Number(r.cnt || 0),
      affected_users: Number(r.users || 0),
      last_seen_ts: Number(r.last_ts || 0),
    }));
  }

  // SQLite 兜底：json_extract 同样支持，字段语义保持一致
  const rows = getDb()
    .prepare(
      `SELECT
         json_extract(params_json, '$.scene')   AS scene,
         json_extract(params_json, '$.ad_type') AS ad_type,
         json_extract(params_json, '$.err_code') AS err_code,
         substr(json_extract(params_json, '$.err_msg'), 1, 200) AS err_msg,
         COUNT(*) AS cnt,
         COUNT(DISTINCT ${userKeySql}) AS users,
         MAX(event_ts) AS last_ts
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = 'ad_error'
          AND event_ts BETWEEN ? AND ?
        GROUP BY scene, ad_type, err_code, err_msg
        ORDER BY cnt DESC
        LIMIT ?`,
    )
    .all(gameKey, fromTs, toTs, limit) as Array<{
    scene: string | null;
    ad_type: string | null;
    err_code: string | number | null;
    err_msg: string | null;
    cnt: number;
    users: number;
    last_ts: number;
  }>;
  return rows.map((r) => ({
    scene: r.scene || 'unknown',
    ad_type: r.ad_type || 'unknown',
    err_code: r.err_code != null ? String(r.err_code) : '',
    err_msg: r.err_msg || '',
    count: Number(r.cnt || 0),
    affected_users: Number(r.users || 0),
    last_seen_ts: Number(r.last_ts || 0),
  }));
}

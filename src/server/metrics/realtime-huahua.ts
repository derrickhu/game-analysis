/**
 * 花花妙屋专属玩法看板（合成经营 / 订单 / 成长 / 参与度）
 *
 * 数据源：analytics_events 中的花花玩法事件，与 game2D_huahua/src/analytics/index.ts 中
 * EventBus → analytics.track 的转发对齐。事件名清单与 EVENT_NAMES 中合成经营段对齐：
 *   merge_success / order_spawn / order_deliver / order_expire / order_ditch /
 *   decoration_purchase / dressup_unlock / star_level_up /
 *   daily_quest_claim / weekly_milestone_claim / checkin_sign /
 *   fountain_draw / affinity_card_drop / collection_discover /
 *   idle_reward_claim / stamina_buy / stamina_ad_recover
 *
 * 面板划分：
 *   1. economy   ：花愿/钻石入账出账渠道分布、净流时间序列（经济流转健康度）
 *   2. order     ：订单 spawn → deliver/expire/ditch 漏斗、按 tier 分布（订单转化）
 *   3. growth    ：星级升级分布、tutorial_step 引导漏斗（成长 + 引导）
 *   4. engagement：日常任务/周里程碑/签到/抽奖/熟客卡 5 类事件次数（参与度）
 *
 * 实现约定：
 * - 全部按 [fromTs, toTs] 窗口算，与 overview / ad-revenue 同口径
 * - 只走 MySQL 分支（getDb() 已 throw），sqlite 不再支持
 * - 用户去重 key = COALESCE(NULLIF(user_id, ''), anonymous_id)
 * - merge_success 事件 SDK init 时降到 10% 采样，KPI 显示时**已折算**回 100%
 */

import { getMysqlPool, isMysqlMode } from '../db';
import { BUCKET_SIZE_MS, bucketToTs, tsToBucket } from './bucket';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";

/** merge_success 默认 10% 采样，估算实际值时把样本数 ×10 折算回去 */
const MERGE_SAMPLING_INVERSE = 10;

function ensureMysql(): void {
  if (!isMysqlMode()) {
    throw new Error('huahua 玩法看板只支持 MySQL 存储');
  }
}

// ============================================================
// 1. 经济流转
// ============================================================

export interface HuahuaEconomyChannelRow {
  /** 渠道事件名，如 order_deliver / decoration_purchase */
  channel: string;
  /** 该渠道当前窗口入账或出账总量（整数，单位币种本位） */
  amount: number;
  /** 该渠道事件触发次数 */
  cnt: number;
}

export interface HuahuaEconomySeriesPoint {
  bucket: string;
  ts: number;
  /** 该桶花愿入账 */
  huayuan_in: number;
  /** 该桶花愿出账 */
  huayuan_out: number;
  /** 该桶钻石入账 */
  diamond_in: number;
  /** 该桶钻石出账 */
  diamond_out: number;
}

export interface HuahuaEconomyKpi {
  huayuan_in: number;
  huayuan_out: number;
  /** 净流 = in - out，负数表示出账多于入账（玩家在消耗存量） */
  huayuan_net: number;
  diamond_in: number;
  diamond_out: number;
  diamond_net: number;
  /** 体力购买（钻石→体力）触发次数 */
  stamina_buy_cnt: number;
  /** 体力广告恢复触发次数 */
  stamina_ad_cnt: number;
  /** 该窗口产生过任意经济事件的去重用户数（活跃经济玩家） */
  active_economy_users: number;
  computed_at: number;
}

export interface HuahuaEconomyResult {
  kpi: HuahuaEconomyKpi;
  /** 花愿入账渠道明细（order_deliver / idle_reward_claim / checkin_sign / fountain_draw 等） */
  huayuan_in_channels: HuahuaEconomyChannelRow[];
  /** 花愿出账渠道明细（decoration_purchase / dressup_unlock） */
  huayuan_out_channels: HuahuaEconomyChannelRow[];
  /** 钻石入账渠道明细 */
  diamond_in_channels: HuahuaEconomyChannelRow[];
  /** 钻石出账渠道明细 */
  diamond_out_channels: HuahuaEconomyChannelRow[];
  series: HuahuaEconomySeriesPoint[];
}

/**
 * 各事件 → params 字段映射，用于 SUM 聚合。每条 (event, field) 对应一个入/出账渠道。
 * 把映射放数据上声明，是为了新增渠道时只动这张表，不用改 SQL。
 */
const HUAYUAN_IN_CHANNELS: Array<{ event: string; field: string; label: string }> = [
  { event: 'order_deliver', field: 'huayuan_reward', label: 'order_deliver' },
  { event: 'idle_reward_claim', field: 'huayuan', label: 'idle_reward_claim' },
  { event: 'checkin_sign', field: 'huayuan', label: 'checkin_sign' },
  { event: 'fountain_draw', field: 'direct_huayuan', label: 'fountain_draw' },
];

const HUAYUAN_OUT_CHANNELS: Array<{ event: string; field: string; label: string }> = [
  { event: 'decoration_purchase', field: 'huayuan_cost', label: 'decoration_purchase' },
  { event: 'dressup_unlock', field: 'huayuan_cost', label: 'dressup_unlock' },
];

const DIAMOND_IN_CHANNELS: Array<{ event: string; field: string; label: string }> = [
  { event: 'order_deliver', field: 'diamond_reward', label: 'order_deliver' },
  { event: 'idle_reward_claim', field: 'diamond', label: 'idle_reward_claim' },
  { event: 'checkin_sign', field: 'diamond', label: 'checkin_sign' },
  { event: 'checkin_sign', field: 'streak_bonus_diamond', label: 'checkin_streak_bonus' },
  { event: 'fountain_draw', field: 'direct_diamond', label: 'fountain_draw' },
];

const DIAMOND_OUT_CHANNELS: Array<{ event: string; field: string; label: string }> = [
  { event: 'stamina_buy', field: 'diamond_cost', label: 'stamina_buy' },
];

async function sumChannelAmount(
  gameKey: string,
  fromTs: number,
  toTs: number,
  channels: Array<{ event: string; field: string; label: string }>,
): Promise<HuahuaEconomyChannelRow[]> {
  if (channels.length === 0) return [];
  const pool = await getMysqlPool();
  // 一行一个渠道：相同 event 不同 field（如 checkin_sign.diamond / streak_bonus_diamond）拆 2 行
  const out: HuahuaEconomyChannelRow[] = [];
  for (const c of channels) {
    const [rows] = await pool.query(
      `SELECT
         COUNT(*) AS cnt,
         COALESCE(SUM(CAST(JSON_EXTRACT(params_json, ?) AS SIGNED)), 0) AS amount
       FROM analytics_events
       WHERE game_key = ? AND event_name = ?
         AND event_ts BETWEEN ? AND ?`,
      [`$.${c.field}`, gameKey, c.event, fromTs, toTs],
    );
    const r = (rows as Array<{ cnt: number; amount: number }>)[0];
    const amount = Number(r?.amount || 0);
    const cnt = Number(r?.cnt || 0);
    // 0 amount + 0 cnt 的渠道可省略，但保留可让前端展示"已接入但当前无数据"
    out.push({ channel: c.label, amount, cnt });
  }
  // 按金额降序，便于前端 Top N 展示
  return out.sort((a, b) => b.amount - a.amount);
}

/** 该窗口任意经济事件去重用户数 = 任一入/出账渠道事件名出现过的 user_key 集合大小 */
async function countEconomyActiveUsers(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<number> {
  const pool = await getMysqlPool();
  const allEvents = Array.from(
    new Set([
      ...HUAYUAN_IN_CHANNELS.map((c) => c.event),
      ...HUAYUAN_OUT_CHANNELS.map((c) => c.event),
      ...DIAMOND_IN_CHANNELS.map((c) => c.event),
      ...DIAMOND_OUT_CHANNELS.map((c) => c.event),
      'stamina_buy',
      'stamina_ad_recover',
    ]),
  );
  const placeholders = allEvents.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT COUNT(DISTINCT ${USER_KEY_SQL}) AS uu
       FROM analytics_events
      WHERE game_key = ? AND event_name IN (${placeholders})
        AND event_ts BETWEEN ? AND ?`,
    [gameKey, ...allEvents, fromTs, toTs],
  );
  return Number((rows as Array<{ uu: number }>)[0]?.uu || 0);
}

/** 体力补给次数：分别取 stamina_buy / stamina_ad_recover */
async function countStaminaSupply(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<{ stamina_buy_cnt: number; stamina_ad_cnt: number }> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT event_name, COUNT(*) AS c
       FROM analytics_events
      WHERE game_key = ? AND event_name IN ('stamina_buy','stamina_ad_recover')
        AND event_ts BETWEEN ? AND ?
      GROUP BY event_name`,
    [gameKey, fromTs, toTs],
  );
  let buy = 0;
  let ad = 0;
  for (const r of rows as Array<{ event_name: string; c: number }>) {
    if (r.event_name === 'stamina_buy') buy = Number(r.c);
    else if (r.event_name === 'stamina_ad_recover') ad = Number(r.c);
  }
  return { stamina_buy_cnt: buy, stamina_ad_cnt: ad };
}

/**
 * 经济流时间序列：把所有入/出账事件×字段一次拉出来，在 JS 里按 5 分钟桶分组并求和。
 * 数据量评估：每个用户每天最多触发约 100 次经济事件，假设 1k DAU 每窗口 10w 行——
 * 在 MySQL 上单次扫描 ~50ms，可接受。如果未来 DAU 涨到 10w+ 再做物化视图。
 */
async function computeEconomySeries(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HuahuaEconomySeriesPoint[]> {
  const pool = await getMysqlPool();
  const allEvents = Array.from(
    new Set([
      ...HUAYUAN_IN_CHANNELS.map((c) => c.event),
      ...HUAYUAN_OUT_CHANNELS.map((c) => c.event),
      ...DIAMOND_IN_CHANNELS.map((c) => c.event),
      ...DIAMOND_OUT_CHANNELS.map((c) => c.event),
    ]),
  );
  const placeholders = allEvents.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT event_name, event_ts, params_json
       FROM analytics_events
      WHERE game_key = ? AND event_name IN (${placeholders})
        AND event_ts BETWEEN ? AND ?`,
    [gameKey, ...allEvents, fromTs, toTs],
  );

  const map = new Map<string, HuahuaEconomySeriesPoint>();
  const startBucketTs = bucketToTs(tsToBucket(fromTs));
  const endBucketTs = bucketToTs(tsToBucket(toTs));
  for (let ts = startBucketTs; ts <= endBucketTs; ts += BUCKET_SIZE_MS) {
    const b = tsToBucket(ts);
    map.set(b, { bucket: b, ts, huayuan_in: 0, huayuan_out: 0, diamond_in: 0, diamond_out: 0 });
  }

  // analytics_events.params_json 在 MySQL 是 JSON 列，mysql2 driver 会**自动 parse 成对象**返回，
  // 这种情况下不能再 JSON.parse（否则收到 '[object Object]' 抛 SyntaxError，被 catch 吞掉后整条 row 丢失，
  // series 全 0 但 KPI 正常的诡异现象就是这么来的——KPI 走 SQL 端 SUM(JSON_EXTRACT(...))，不进客户端 parse）。
  // 兼容：如果未来从 SQLite/旧版本拿到字符串型 params_json，也照样 parse。realtime-ad.ts 同款写法。
  for (const r of rows as Array<{
    event_name: string;
    event_ts: number;
    params_json: string | Record<string, unknown> | null;
  }>) {
    const bucket = tsToBucket(Number(r.event_ts));
    const slot = map.get(bucket);
    if (!slot) continue;
    let params: Record<string, unknown> = {};
    if (typeof r.params_json === 'string') {
      try {
        params = JSON.parse(r.params_json) || {};
      } catch {
        continue;
      }
    } else if (r.params_json && typeof r.params_json === 'object') {
      params = r.params_json;
    }
    const ev = r.event_name;
    for (const c of HUAYUAN_IN_CHANNELS) {
      if (c.event === ev) slot.huayuan_in += Number(params[c.field] || 0);
    }
    for (const c of HUAYUAN_OUT_CHANNELS) {
      if (c.event === ev) slot.huayuan_out += Number(params[c.field] || 0);
    }
    for (const c of DIAMOND_IN_CHANNELS) {
      if (c.event === ev) slot.diamond_in += Number(params[c.field] || 0);
    }
    for (const c of DIAMOND_OUT_CHANNELS) {
      if (c.event === ev) slot.diamond_out += Number(params[c.field] || 0);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

export async function getHuahuaEconomyOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HuahuaEconomyResult> {
  ensureMysql();
  const [
    huayuanIn,
    huayuanOut,
    diamondIn,
    diamondOut,
    activeUsers,
    stamina,
    series,
  ] = await Promise.all([
    sumChannelAmount(gameKey, fromTs, toTs, HUAYUAN_IN_CHANNELS),
    sumChannelAmount(gameKey, fromTs, toTs, HUAYUAN_OUT_CHANNELS),
    sumChannelAmount(gameKey, fromTs, toTs, DIAMOND_IN_CHANNELS),
    sumChannelAmount(gameKey, fromTs, toTs, DIAMOND_OUT_CHANNELS),
    countEconomyActiveUsers(gameKey, fromTs, toTs),
    countStaminaSupply(gameKey, fromTs, toTs),
    computeEconomySeries(gameKey, fromTs, toTs),
  ]);
  const totalIn = huayuanIn.reduce((s, r) => s + r.amount, 0);
  const totalOut = huayuanOut.reduce((s, r) => s + r.amount, 0);
  const totalDIn = diamondIn.reduce((s, r) => s + r.amount, 0);
  const totalDOut = diamondOut.reduce((s, r) => s + r.amount, 0);
  return {
    kpi: {
      huayuan_in: totalIn,
      huayuan_out: totalOut,
      huayuan_net: totalIn - totalOut,
      diamond_in: totalDIn,
      diamond_out: totalDOut,
      diamond_net: totalDIn - totalDOut,
      stamina_buy_cnt: stamina.stamina_buy_cnt,
      stamina_ad_cnt: stamina.stamina_ad_cnt,
      active_economy_users: activeUsers,
      computed_at: Date.now(),
    },
    huayuan_in_channels: huayuanIn,
    huayuan_out_channels: huayuanOut,
    diamond_in_channels: diamondIn,
    diamond_out_channels: diamondOut,
    series,
  };
}

// ============================================================
// 2. 订单转化
// ============================================================

export interface HuahuaOrderTierRow {
  tier: string;
  spawn_cnt: number;
  deliver_cnt: number;
  expire_cnt: number;
  ditch_cnt: number;
  /** = deliver / spawn，spawn=0 时 null */
  deliver_rate: number | null;
}

export interface HuahuaOrderSeriesPoint {
  bucket: string;
  ts: number;
  spawn_cnt: number;
  deliver_cnt: number;
  expire_cnt: number;
  ditch_cnt: number;
}

export interface HuahuaOrderKpi {
  spawn_cnt: number;
  deliver_cnt: number;
  expire_cnt: number;
  ditch_cnt: number;
  /** 完成率 = deliver / spawn */
  deliver_rate: number | null;
  /** 限时单（order_type=timed）专属完成率 */
  timed_deliver_rate: number | null;
  /** 总花愿产出（来自 order_deliver.huayuan_reward） */
  total_huayuan_from_orders: number;
  /** 总钻石产出（限时单 diamond_reward 累加） */
  total_diamond_from_orders: number;
  computed_at: number;
}

export interface HuahuaOrderResult {
  kpi: HuahuaOrderKpi;
  by_tier: HuahuaOrderTierRow[];
  series: HuahuaOrderSeriesPoint[];
}

const ORDER_EVENTS = ['order_spawn', 'order_deliver', 'order_expire', 'order_ditch'] as const;
type OrderEventName = (typeof ORDER_EVENTS)[number];

async function countOrderEvents(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<Record<OrderEventName, number>> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT event_name, COUNT(*) AS c
       FROM analytics_events
      WHERE game_key = ? AND event_name IN (?,?,?,?)
        AND event_ts BETWEEN ? AND ?
      GROUP BY event_name`,
    [gameKey, ...ORDER_EVENTS, fromTs, toTs],
  );
  const out: Record<OrderEventName, number> = {
    order_spawn: 0,
    order_deliver: 0,
    order_expire: 0,
    order_ditch: 0,
  };
  for (const r of rows as Array<{ event_name: OrderEventName; c: number }>) {
    out[r.event_name] = Number(r.c);
  }
  return out;
}

/** 限时单完成率分子分母 = order_type='timed' 的 deliver / spawn */
async function countTimedOrderRate(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<{ spawn: number; deliver: number }> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT event_name, COUNT(*) AS c
       FROM analytics_events
      WHERE game_key = ? AND event_name IN ('order_spawn','order_deliver')
        AND JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.order_type')) = 'timed'
        AND event_ts BETWEEN ? AND ?
      GROUP BY event_name`,
    [gameKey, fromTs, toTs],
  );
  let spawn = 0;
  let deliver = 0;
  for (const r of rows as Array<{ event_name: string; c: number }>) {
    if (r.event_name === 'order_spawn') spawn = Number(r.c);
    else if (r.event_name === 'order_deliver') deliver = Number(r.c);
  }
  return { spawn, deliver };
}

async function sumOrderRewards(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<{ total_huayuan: number; total_diamond: number }> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
        COALESCE(SUM(CAST(JSON_EXTRACT(params_json, '$.huayuan_reward') AS SIGNED)), 0) AS hy,
        COALESCE(SUM(CAST(JSON_EXTRACT(params_json, '$.diamond_reward') AS SIGNED)), 0) AS dm
       FROM analytics_events
      WHERE game_key = ? AND event_name = 'order_deliver'
        AND event_ts BETWEEN ? AND ?`,
    [gameKey, fromTs, toTs],
  );
  const r = (rows as Array<{ hy: number; dm: number }>)[0];
  return {
    total_huayuan: Number(r?.hy || 0),
    total_diamond: Number(r?.dm || 0),
  };
}

async function computeOrderTierDistribution(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HuahuaOrderTierRow[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
        event_name,
        JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.tier')) AS tier,
        COUNT(*) AS c
       FROM analytics_events
      WHERE game_key = ? AND event_name IN (?,?,?,?)
        AND event_ts BETWEEN ? AND ?
      GROUP BY event_name, tier`,
    [gameKey, ...ORDER_EVENTS, fromTs, toTs],
  );
  const map = new Map<string, HuahuaOrderTierRow>();
  for (const r of rows as Array<{ event_name: OrderEventName; tier: string | null; c: number }>) {
    const tier = r.tier || 'unknown';
    if (!map.has(tier)) {
      map.set(tier, {
        tier,
        spawn_cnt: 0,
        deliver_cnt: 0,
        expire_cnt: 0,
        ditch_cnt: 0,
        deliver_rate: null,
      });
    }
    const row = map.get(tier)!;
    const c = Number(r.c);
    if (r.event_name === 'order_spawn') row.spawn_cnt = c;
    else if (r.event_name === 'order_deliver') row.deliver_cnt = c;
    else if (r.event_name === 'order_expire') row.expire_cnt = c;
    else if (r.event_name === 'order_ditch') row.ditch_cnt = c;
  }
  for (const row of map.values()) {
    row.deliver_rate = row.spawn_cnt > 0 ? row.deliver_cnt / row.spawn_cnt : null;
  }
  // tier 字符串排序通常 T1 < T2 < T3 < timed < unknown 即合理
  return Array.from(map.values()).sort((a, b) => a.tier.localeCompare(b.tier));
}

async function computeOrderSeries(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HuahuaOrderSeriesPoint[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT event_name, event_ts
       FROM analytics_events
      WHERE game_key = ? AND event_name IN (?,?,?,?)
        AND event_ts BETWEEN ? AND ?`,
    [gameKey, ...ORDER_EVENTS, fromTs, toTs],
  );
  const map = new Map<string, HuahuaOrderSeriesPoint>();
  const startBucketTs = bucketToTs(tsToBucket(fromTs));
  const endBucketTs = bucketToTs(tsToBucket(toTs));
  for (let ts = startBucketTs; ts <= endBucketTs; ts += BUCKET_SIZE_MS) {
    const b = tsToBucket(ts);
    map.set(b, { bucket: b, ts, spawn_cnt: 0, deliver_cnt: 0, expire_cnt: 0, ditch_cnt: 0 });
  }
  for (const r of rows as Array<{ event_name: OrderEventName; event_ts: number }>) {
    const bucket = tsToBucket(Number(r.event_ts));
    const slot = map.get(bucket);
    if (!slot) continue;
    if (r.event_name === 'order_spawn') slot.spawn_cnt++;
    else if (r.event_name === 'order_deliver') slot.deliver_cnt++;
    else if (r.event_name === 'order_expire') slot.expire_cnt++;
    else if (r.event_name === 'order_ditch') slot.ditch_cnt++;
  }
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

export async function getHuahuaOrderOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HuahuaOrderResult> {
  ensureMysql();
  const [counts, timed, rewards, byTier, series] = await Promise.all([
    countOrderEvents(gameKey, fromTs, toTs),
    countTimedOrderRate(gameKey, fromTs, toTs),
    sumOrderRewards(gameKey, fromTs, toTs),
    computeOrderTierDistribution(gameKey, fromTs, toTs),
    computeOrderSeries(gameKey, fromTs, toTs),
  ]);
  return {
    kpi: {
      spawn_cnt: counts.order_spawn,
      deliver_cnt: counts.order_deliver,
      expire_cnt: counts.order_expire,
      ditch_cnt: counts.order_ditch,
      deliver_rate: counts.order_spawn > 0 ? counts.order_deliver / counts.order_spawn : null,
      timed_deliver_rate: timed.spawn > 0 ? timed.deliver / timed.spawn : null,
      total_huayuan_from_orders: rewards.total_huayuan,
      total_diamond_from_orders: rewards.total_diamond,
      computed_at: Date.now(),
    },
    by_tier: byTier,
    series,
  };
}

// ============================================================
// 3. 成长 + 引导
// ============================================================

export interface HuahuaStarLevelRow {
  /** 升星到达的目标星级 */
  to_level: number;
  /** 该星级有多少独立用户达到过 */
  user_cnt: number;
  /** 该星级有多少次升级事件（一个用户可能在窗口内多次升级到同一级别——理论上不会，因为星级单调） */
  event_cnt: number;
}

export interface HuahuaTutorialStepRow {
  step_id: string;
  /** 触发该步 done 的去重用户数（漏斗分子分母） */
  user_cnt: number;
  /** done 事件总次数（重复触发时大于 user_cnt） */
  event_cnt: number;
  /** 平均耗时（毫秒），从上一步到当前步 */
  avg_duration_ms: number;
}

export interface HuahuaGrowthKpi {
  /** 升星总次数 */
  total_level_ups: number;
  /** 当前窗口产生过升星的去重用户数 */
  level_up_users: number;
  /** 窗口内最高达到的星级 */
  max_level_reached: number;
  /** 教程完成（tutorial_completed）的去重用户数 */
  tutorial_completed_users: number;
  /** 启动 SESSION_START 的去重用户数（教程漏斗分母 = 当前窗口启动用户） */
  session_users: number;
  /** 教程完成率 = tutorial_completed_users / session_users */
  tutorial_complete_rate: number | null;
  computed_at: number;
}

export interface HuahuaGrowthResult {
  kpi: HuahuaGrowthKpi;
  level_distribution: HuahuaStarLevelRow[];
  tutorial_funnel: HuahuaTutorialStepRow[];
}

async function computeStarLevelDistribution(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<{ rows: HuahuaStarLevelRow[]; totalEvents: number; uniqueUsers: number; maxLevel: number }> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
        CAST(JSON_EXTRACT(params_json, '$.new_level') AS SIGNED) AS lv,
        ${USER_KEY_SQL} AS uk
       FROM analytics_events
      WHERE game_key = ? AND event_name = 'star_level_up'
        AND event_ts BETWEEN ? AND ?`,
    [gameKey, fromTs, toTs],
  );
  const userByLevel = new Map<number, Set<string>>();
  const eventByLevel = new Map<number, number>();
  const allUsers = new Set<string>();
  let totalEvents = 0;
  let maxLevel = 0;
  for (const r of rows as Array<{ lv: number | null; uk: string }>) {
    const lv = Number(r.lv);
    if (!Number.isFinite(lv) || lv <= 0) continue;
    if (!userByLevel.has(lv)) userByLevel.set(lv, new Set());
    userByLevel.get(lv)!.add(r.uk);
    eventByLevel.set(lv, (eventByLevel.get(lv) || 0) + 1);
    allUsers.add(r.uk);
    totalEvents++;
    if (lv > maxLevel) maxLevel = lv;
  }
  const out: HuahuaStarLevelRow[] = Array.from(userByLevel.entries())
    .sort(([a], [b]) => a - b)
    .map(([lv, users]) => ({
      to_level: lv,
      user_cnt: users.size,
      event_cnt: eventByLevel.get(lv) || 0,
    }));
  return { rows: out, totalEvents, uniqueUsers: allUsers.size, maxLevel };
}

async function computeTutorialFunnel(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<{ rows: HuahuaTutorialStepRow[]; completedUsers: number }> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
        JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.step_id')) AS step_id,
        CAST(JSON_EXTRACT(params_json, '$.step_index') AS SIGNED) AS step_index,
        CAST(JSON_EXTRACT(params_json, '$.duration_ms') AS SIGNED) AS duration_ms,
        ${USER_KEY_SQL} AS uk
       FROM analytics_events
      WHERE game_key = ? AND event_name = 'tutorial_step'
        AND JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.status')) = 'done'
        AND event_ts BETWEEN ? AND ?`,
    [gameKey, fromTs, toTs],
  );
  // 用 step_index 排序（更稳）；同 step_index 共享一行（理论唯一）
  const userByStep = new Map<string, Set<string>>();
  const eventByStep = new Map<string, number>();
  const stepIndex = new Map<string, number>();
  const durationByStep = new Map<string, { sum: number; cnt: number }>();
  let completedUsers = new Set<string>();
  for (const r of rows as Array<{
    step_id: string | null;
    step_index: number | null;
    duration_ms: number | null;
    uk: string;
  }>) {
    const step = r.step_id || 'unknown';
    if (!userByStep.has(step)) userByStep.set(step, new Set());
    userByStep.get(step)!.add(r.uk);
    eventByStep.set(step, (eventByStep.get(step) || 0) + 1);
    if (r.step_index !== null && r.step_index !== undefined) {
      stepIndex.set(step, Number(r.step_index));
    }
    const d = Number(r.duration_ms || 0);
    if (Number.isFinite(d) && d > 0) {
      const cur = durationByStep.get(step) || { sum: 0, cnt: 0 };
      cur.sum += d;
      cur.cnt++;
      durationByStep.set(step, cur);
    }
    if (step === 'tutorial_completed') {
      completedUsers.add(r.uk);
    }
  }
  const out: HuahuaTutorialStepRow[] = Array.from(userByStep.entries())
    .map(([step_id, users]) => {
      const dur = durationByStep.get(step_id);
      return {
        step_id,
        user_cnt: users.size,
        event_cnt: eventByStep.get(step_id) || 0,
        avg_duration_ms: dur && dur.cnt > 0 ? Math.round(dur.sum / dur.cnt) : 0,
      };
    })
    .sort((a, b) => {
      // 优先按 step_index 排序，未知 step_index 落到末尾
      const ai = stepIndex.get(a.step_id);
      const bi = stepIndex.get(b.step_id);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.step_id.localeCompare(b.step_id);
    });
  return { rows: out, completedUsers: completedUsers.size };
}

async function countSessionUsers(gameKey: string, fromTs: number, toTs: number): Promise<number> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT COUNT(DISTINCT ${USER_KEY_SQL}) AS uu
       FROM analytics_events
      WHERE game_key = ? AND event_name = 'session_start'
        AND event_ts BETWEEN ? AND ?`,
    [gameKey, fromTs, toTs],
  );
  return Number((rows as Array<{ uu: number }>)[0]?.uu || 0);
}

export async function getHuahuaGrowthOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HuahuaGrowthResult> {
  ensureMysql();
  const [levelDist, tutorial, sessionUsers] = await Promise.all([
    computeStarLevelDistribution(gameKey, fromTs, toTs),
    computeTutorialFunnel(gameKey, fromTs, toTs),
    countSessionUsers(gameKey, fromTs, toTs),
  ]);
  return {
    kpi: {
      total_level_ups: levelDist.totalEvents,
      level_up_users: levelDist.uniqueUsers,
      max_level_reached: levelDist.maxLevel,
      tutorial_completed_users: tutorial.completedUsers,
      session_users: sessionUsers,
      tutorial_complete_rate:
        sessionUsers > 0 ? tutorial.completedUsers / sessionUsers : null,
      computed_at: Date.now(),
    },
    level_distribution: levelDist.rows,
    tutorial_funnel: tutorial.rows,
  };
}

// ============================================================
// 4. 参与度
// ============================================================

export interface HuahuaEngagementSeriesPoint {
  bucket: string;
  ts: number;
  daily_quest_cnt: number;
  weekly_milestone_cnt: number;
  checkin_cnt: number;
  fountain_draw_cnt: number;
  affinity_card_cnt: number;
  /** merge_success 已折算回 100%（×10） */
  merge_success_cnt_estimated: number;
}

export interface HuahuaEngagementTopRow {
  /** template_id / milestone_id / draw_kind 等业务子维度 */
  key: string;
  cnt: number;
}

export interface HuahuaEngagementKpi {
  daily_quest_claim_cnt: number;
  daily_quest_users: number;
  weekly_milestone_cnt: number;
  weekly_milestone_users: number;
  checkin_users: number;
  fountain_draw_cnt: number;
  fountain_draw_users: number;
  /** SSR 抽卡数太复杂，先看重复率 = sum(duplicate_count) / sum(card_count) */
  affinity_drop_users: number;
  affinity_card_total: number;
  affinity_duplicate_rate: number | null;
  /** merge_success 是 10% 采样事件，估算实际 = 样本数 × 10 */
  merge_success_estimated: number;
  collection_discover_cnt: number;
  computed_at: number;
}

export interface HuahuaEngagementResult {
  kpi: HuahuaEngagementKpi;
  /** 5 分钟桶各事件次数序列 */
  series: HuahuaEngagementSeriesPoint[];
  /** Top 日常任务模板（template_id 分布） */
  top_daily_quests: HuahuaEngagementTopRow[];
  /** 抽奖 draw_kind 分布 */
  fountain_draw_breakdown: HuahuaEngagementTopRow[];
}

const ENGAGEMENT_EVENTS = [
  'daily_quest_claim',
  'weekly_milestone_claim',
  'checkin_sign',
  'fountain_draw',
  'affinity_card_drop',
  'merge_success',
  'collection_discover',
] as const;

async function computeEngagementCounts(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<{
  daily_quest_claim_cnt: number;
  daily_quest_users: number;
  weekly_milestone_cnt: number;
  weekly_milestone_users: number;
  checkin_cnt: number;
  checkin_users: number;
  fountain_draw_cnt: number;
  fountain_draw_users: number;
  affinity_drop_cnt: number;
  affinity_drop_users: number;
  merge_success_cnt: number;
  collection_discover_cnt: number;
}> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
        event_name,
        COUNT(*) AS c,
        COUNT(DISTINCT ${USER_KEY_SQL}) AS uu
       FROM analytics_events
      WHERE game_key = ? AND event_name IN (?,?,?,?,?,?,?)
        AND event_ts BETWEEN ? AND ?
      GROUP BY event_name`,
    [gameKey, ...ENGAGEMENT_EVENTS, fromTs, toTs],
  );
  const out: Record<string, { c: number; uu: number }> = {};
  for (const r of rows as Array<{ event_name: string; c: number; uu: number }>) {
    out[r.event_name] = { c: Number(r.c), uu: Number(r.uu) };
  }
  const get = (name: string) => out[name] || { c: 0, uu: 0 };
  return {
    daily_quest_claim_cnt: get('daily_quest_claim').c,
    daily_quest_users: get('daily_quest_claim').uu,
    weekly_milestone_cnt: get('weekly_milestone_claim').c,
    weekly_milestone_users: get('weekly_milestone_claim').uu,
    checkin_cnt: get('checkin_sign').c,
    checkin_users: get('checkin_sign').uu,
    fountain_draw_cnt: get('fountain_draw').c,
    fountain_draw_users: get('fountain_draw').uu,
    affinity_drop_cnt: get('affinity_card_drop').c,
    affinity_drop_users: get('affinity_card_drop').uu,
    merge_success_cnt: get('merge_success').c,
    collection_discover_cnt: get('collection_discover').c,
  };
}

async function computeAffinityCardSummary(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<{ total_cards: number; duplicate_cards: number }> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
        COALESCE(SUM(CAST(JSON_EXTRACT(params_json, '$.card_count') AS SIGNED)), 0) AS total,
        COALESCE(SUM(CAST(JSON_EXTRACT(params_json, '$.duplicate_count') AS SIGNED)), 0) AS dup
       FROM analytics_events
      WHERE game_key = ? AND event_name = 'affinity_card_drop'
        AND event_ts BETWEEN ? AND ?`,
    [gameKey, fromTs, toTs],
  );
  const r = (rows as Array<{ total: number; dup: number }>)[0];
  return { total_cards: Number(r?.total || 0), duplicate_cards: Number(r?.dup || 0) };
}

async function computeEngagementSeries(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HuahuaEngagementSeriesPoint[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT event_name, event_ts
       FROM analytics_events
      WHERE game_key = ? AND event_name IN (?,?,?,?,?,?,?)
        AND event_ts BETWEEN ? AND ?`,
    [gameKey, ...ENGAGEMENT_EVENTS, fromTs, toTs],
  );
  const map = new Map<string, HuahuaEngagementSeriesPoint>();
  const startBucketTs = bucketToTs(tsToBucket(fromTs));
  const endBucketTs = bucketToTs(tsToBucket(toTs));
  for (let ts = startBucketTs; ts <= endBucketTs; ts += BUCKET_SIZE_MS) {
    const b = tsToBucket(ts);
    map.set(b, {
      bucket: b,
      ts,
      daily_quest_cnt: 0,
      weekly_milestone_cnt: 0,
      checkin_cnt: 0,
      fountain_draw_cnt: 0,
      affinity_card_cnt: 0,
      merge_success_cnt_estimated: 0,
    });
  }
  for (const r of rows as Array<{ event_name: string; event_ts: number }>) {
    const slot = map.get(tsToBucket(Number(r.event_ts)));
    if (!slot) continue;
    switch (r.event_name) {
      case 'daily_quest_claim':
        slot.daily_quest_cnt++;
        break;
      case 'weekly_milestone_claim':
        slot.weekly_milestone_cnt++;
        break;
      case 'checkin_sign':
        slot.checkin_cnt++;
        break;
      case 'fountain_draw':
        slot.fountain_draw_cnt++;
        break;
      case 'affinity_card_drop':
        slot.affinity_card_cnt++;
        break;
      case 'merge_success':
        slot.merge_success_cnt_estimated += MERGE_SAMPLING_INVERSE;
        break;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

async function computeTopDailyQuests(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HuahuaEngagementTopRow[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
        JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.template_id')) AS k,
        COUNT(*) AS c
       FROM analytics_events
      WHERE game_key = ? AND event_name = 'daily_quest_claim'
        AND event_ts BETWEEN ? AND ?
      GROUP BY k
      ORDER BY c DESC
      LIMIT 10`,
    [gameKey, fromTs, toTs],
  );
  return (rows as Array<{ k: string | null; c: number }>).map((r) => ({
    key: r.k || 'unknown',
    cnt: Number(r.c),
  }));
}

async function computeFountainBreakdown(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HuahuaEngagementTopRow[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
        JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.draw_kind')) AS k,
        COUNT(*) AS c
       FROM analytics_events
      WHERE game_key = ? AND event_name = 'fountain_draw'
        AND event_ts BETWEEN ? AND ?
      GROUP BY k
      ORDER BY c DESC`,
    [gameKey, fromTs, toTs],
  );
  return (rows as Array<{ k: string | null; c: number }>).map((r) => ({
    key: r.k || 'unknown',
    cnt: Number(r.c),
  }));
}

export async function getHuahuaEngagementOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HuahuaEngagementResult> {
  ensureMysql();
  const [counts, affinity, series, topQuests, drawBreakdown] = await Promise.all([
    computeEngagementCounts(gameKey, fromTs, toTs),
    computeAffinityCardSummary(gameKey, fromTs, toTs),
    computeEngagementSeries(gameKey, fromTs, toTs),
    computeTopDailyQuests(gameKey, fromTs, toTs),
    computeFountainBreakdown(gameKey, fromTs, toTs),
  ]);
  return {
    kpi: {
      daily_quest_claim_cnt: counts.daily_quest_claim_cnt,
      daily_quest_users: counts.daily_quest_users,
      weekly_milestone_cnt: counts.weekly_milestone_cnt,
      weekly_milestone_users: counts.weekly_milestone_users,
      checkin_users: counts.checkin_users,
      fountain_draw_cnt: counts.fountain_draw_cnt,
      fountain_draw_users: counts.fountain_draw_users,
      affinity_drop_users: counts.affinity_drop_users,
      affinity_card_total: affinity.total_cards,
      affinity_duplicate_rate:
        affinity.total_cards > 0 ? affinity.duplicate_cards / affinity.total_cards : null,
      merge_success_estimated: counts.merge_success_cnt * MERGE_SAMPLING_INVERSE,
      collection_discover_cnt: counts.collection_discover_cnt,
      computed_at: Date.now(),
    },
    series,
    top_daily_quests: topQuests,
    fountain_draw_breakdown: drawBreakdown,
  };
}

/**
 * 花花玩家档案快照聚合查询
 *
 * 数据源：huahua_player_snapshots（每天 04:00 cron 全量拉一次）
 *
 * 与 5 分钟桶事件流的差异：
 *   - 事件流：玩家"做了什么"（增量、5 分钟桶刷新）
 *   - 快照：玩家"现在是什么状态"（绝对值、每天刷新）
 *
 * 接口形态：
 *   - 默认查最新 snapshot_date 的快照（横切面：当前所有玩家的状态分布）
 *   - 同时返回最近 30 天的 daily 趋势（人均等级 / 人均花愿 / 教程完成率）
 *
 * 全部走 MySQL，按 snapshot_date 聚合。索引 idx_date / idx_date_level 已建好，单次 30k 行查询毫秒级。
 */

import { getMysqlPool, isMysqlMode } from '../db';
import {
  getLatestSnapshotMeta,
  type PlayerSnapshotRun,
} from '../snapshot-db';

const SUPPORTED_GAMES = new Set(['huahua']);

function ensureSupported(gameKey: string): void {
  if (!SUPPORTED_GAMES.has(gameKey)) {
    throw new Error(`快照看板暂不支持 ${gameKey}`);
  }
}
function snapshotTable(gameKey: string): string {
  ensureSupported(gameKey);
  return `\`${gameKey}_player_snapshots\``;
}

function ensureMysql(): void {
  if (!isMysqlMode()) {
    throw new Error('snapshot 看板只支持 MySQL');
  }
}

// ============================================================
// 数据结构
// ============================================================

export interface SnapshotKpi {
  user_count: number;
  avg_level: number;
  max_level: number;
  avg_huayuan: number;
  avg_diamond: number;
  avg_stamina: number;
  avg_flower_sign_tickets: number;
  /** 教程完成率（口径：tutorial_completed=1 的玩家数 / 总玩家数） */
  tutorial_completed_rate: number | null;
  avg_total_merges: number;
  avg_total_orders: number;
  /** 至少签到 1 次的玩家占比 */
  checkin_active_rate: number | null;
  /** 平均连续签到天数 */
  avg_checkin_streak: number;
  avg_unlocked_deco: number;
  avg_unlocked_room_styles: number;
  avg_unlocked_outfit: number;
  avg_affinity_cards_owned: number;
  avg_collection_discovered: number;
  avg_active_customers: number;
}

export interface LevelBucket {
  level: number;
  user_cnt: number;
}

export interface ValueBucket {
  /** 分桶标签（如 '0-100' / '100-500'），前端直接展示 */
  bucket: string;
  user_cnt: number;
  /** 桶内最小值（仅排序用） */
  min_value: number;
}

export interface TutorialStepBucket {
  step: number;
  user_cnt: number;
  completed: 0 | 1;
}

export interface DailyTrendPoint {
  date: string;
  user_count: number;
  avg_level: number;
  avg_huayuan: number;
  avg_diamond: number;
  tutorial_completed_rate: number | null;
}

export interface SnapshotResult {
  query: {
    game_key: string;
    snapshot_date: string;
    has_data: boolean;
  };
  kpi: SnapshotKpi | null;
  level_distribution: LevelBucket[];
  huayuan_buckets: ValueBucket[];
  diamond_buckets: ValueBucket[];
  deco_buckets: ValueBucket[];
  tutorial_steps: TutorialStepBucket[];
  daily_trend: DailyTrendPoint[];
  latest_run?: PlayerSnapshotRun | null;
}

// ============================================================
// 分桶规则
// ============================================================

/**
 * 通用分桶：传入边界数组（如 [0, 100, 500, 2000, 10000]），自动生成桶 + 最大兜底桶。
 * 边界必须递增；分桶含左边界、不含右边界（[0,100), [100,500) ...）。
 */
function bucketize(value: number, boundaries: number[]): { bucket: string; min: number } {
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (value >= boundaries[i]! && value < boundaries[i + 1]!) {
      return { bucket: `${boundaries[i]}-${boundaries[i + 1]}`, min: boundaries[i]! };
    }
  }
  // value >= 最大边界 → ">= max"
  const last = boundaries[boundaries.length - 1] || 0;
  return { bucket: `≥${last}`, min: last };
}

const HUAYUAN_BOUNDARIES = [0, 100, 500, 2000, 10000, 50000];
const DIAMOND_BOUNDARIES = [0, 10, 50, 200, 1000];
const DECO_BOUNDARIES = [0, 5, 15, 30, 60];

// ============================================================
// 查询函数
// ============================================================

async function computeKpi(gameKey: string, snapshotDate: string): Promise<SnapshotKpi | null> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
       COUNT(*) AS user_count,
       AVG(level) AS avg_level,
       MAX(level) AS max_level,
       AVG(huayuan) AS avg_huayuan,
       AVG(diamond) AS avg_diamond,
       AVG(stamina) AS avg_stamina,
       AVG(flower_sign_tickets) AS avg_flower_sign_tickets,
       SUM(tutorial_completed) AS tutorial_done_cnt,
       AVG(total_merges) AS avg_total_merges,
       AVG(total_orders) AS avg_total_orders,
       SUM(CASE WHEN checkin_total_days > 0 THEN 1 ELSE 0 END) AS checkin_active_cnt,
       AVG(checkin_streak_days) AS avg_checkin_streak,
       AVG(unlocked_deco_count) AS avg_unlocked_deco,
       AVG(unlocked_room_styles_count) AS avg_unlocked_room_styles,
       AVG(unlocked_outfit_count) AS avg_unlocked_outfit,
       AVG(affinity_card_owned_count) AS avg_affinity_cards_owned,
       AVG(collection_discovered_count) AS avg_collection_discovered,
       AVG(active_customer_count) AS avg_active_customers
     FROM ${snapshotTable(gameKey)}
     WHERE snapshot_date = ?`,
    [snapshotDate],
  );
  const r = (rows as Array<Record<string, any>>)[0];
  if (!r || Number(r.user_count) === 0) return null;
  const userCount = Number(r.user_count);
  return {
    user_count: userCount,
    avg_level: round1(Number(r.avg_level)),
    max_level: Number(r.max_level || 0),
    avg_huayuan: round0(Number(r.avg_huayuan)),
    avg_diamond: round0(Number(r.avg_diamond)),
    avg_stamina: round0(Number(r.avg_stamina)),
    avg_flower_sign_tickets: round0(Number(r.avg_flower_sign_tickets)),
    tutorial_completed_rate: userCount > 0 ? Number(r.tutorial_done_cnt) / userCount : null,
    avg_total_merges: round0(Number(r.avg_total_merges)),
    avg_total_orders: round0(Number(r.avg_total_orders)),
    checkin_active_rate: userCount > 0 ? Number(r.checkin_active_cnt) / userCount : null,
    avg_checkin_streak: round1(Number(r.avg_checkin_streak)),
    avg_unlocked_deco: round1(Number(r.avg_unlocked_deco)),
    avg_unlocked_room_styles: round1(Number(r.avg_unlocked_room_styles)),
    avg_unlocked_outfit: round1(Number(r.avg_unlocked_outfit)),
    avg_affinity_cards_owned: round1(Number(r.avg_affinity_cards_owned)),
    avg_collection_discovered: round1(Number(r.avg_collection_discovered)),
    avg_active_customers: round1(Number(r.avg_active_customers)),
  };
}

function round0(n: number): number {
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

async function computeLevelDistribution(
  gameKey: string,
  snapshotDate: string,
): Promise<LevelBucket[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT level, COUNT(*) AS cnt
       FROM ${snapshotTable(gameKey)}
      WHERE snapshot_date = ?
      GROUP BY level
      ORDER BY level ASC`,
    [snapshotDate],
  );
  return (rows as Array<{ level: number; cnt: number }>).map((r) => ({
    level: Number(r.level),
    user_cnt: Number(r.cnt),
  }));
}

/**
 * 数值字段分桶：取出该字段的所有值在客户端分桶。
 * 玩家数 1k 量级时这种"客户端分桶"完全 OK；如果未来涨到 100k+ 再改 SQL CASE WHEN。
 */
async function computeValueBuckets(
  gameKey: string,
  snapshotDate: string,
  column: 'huayuan' | 'diamond' | 'unlocked_deco_count',
  boundaries: number[],
): Promise<ValueBucket[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT \`${column}\` AS v
       FROM ${snapshotTable(gameKey)}
      WHERE snapshot_date = ?`,
    [snapshotDate],
  );
  const counts = new Map<string, { cnt: number; min: number }>();
  for (const r of rows as Array<{ v: number }>) {
    const v = Number(r.v);
    const { bucket, min } = bucketize(v, boundaries);
    if (!counts.has(bucket)) counts.set(bucket, { cnt: 0, min });
    counts.get(bucket)!.cnt++;
  }
  return Array.from(counts.entries())
    .map(([bucket, { cnt, min }]) => ({ bucket, user_cnt: cnt, min_value: min }))
    .sort((a, b) => a.min_value - b.min_value);
}

async function computeTutorialSteps(
  gameKey: string,
  snapshotDate: string,
): Promise<TutorialStepBucket[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT tutorial_step, tutorial_completed, COUNT(*) AS cnt
       FROM ${snapshotTable(gameKey)}
      WHERE snapshot_date = ?
      GROUP BY tutorial_step, tutorial_completed
      ORDER BY tutorial_step ASC`,
    [snapshotDate],
  );
  return (rows as Array<{ tutorial_step: number; tutorial_completed: number; cnt: number }>).map((r) => ({
    step: Number(r.tutorial_step),
    user_cnt: Number(r.cnt),
    completed: Number(r.tutorial_completed) === 1 ? 1 : 0,
  }));
}

/** 最近 30 天每日趋势：人均关键指标 + 总玩家数 */
async function computeDailyTrend(
  gameKey: string,
  snapshotDate: string,
): Promise<DailyTrendPoint[]> {
  const pool = await getMysqlPool();
  // 取最近 30 个 snapshot_date（含当天），按日期升序
  const [rows] = await pool.query(
    `SELECT
       snapshot_date,
       COUNT(*)      AS user_count,
       AVG(level)    AS avg_level,
       AVG(huayuan)  AS avg_huayuan,
       AVG(diamond)  AS avg_diamond,
       SUM(tutorial_completed) AS done_cnt
     FROM ${snapshotTable(gameKey)}
     WHERE snapshot_date <= ?
     GROUP BY snapshot_date
     ORDER BY snapshot_date DESC
     LIMIT 30`,
    [snapshotDate],
  );
  const list = (rows as Array<Record<string, any>>).map((r) => {
    const userCount = Number(r.user_count);
    return {
      date: String(r.snapshot_date),
      user_count: userCount,
      avg_level: round1(Number(r.avg_level)),
      avg_huayuan: round0(Number(r.avg_huayuan)),
      avg_diamond: round0(Number(r.avg_diamond)),
      tutorial_completed_rate: userCount > 0 ? Number(r.done_cnt) / userCount : null,
    } as DailyTrendPoint;
  });
  // 按日期升序返回（chart 友好）
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================
// 玩家明细分页查询（用于前端表格）
// ============================================================

/** 允许排序的列白名单：所有用户输入都必须经过这里映射，杜绝 SQL 注入 */
const SORTABLE_COLUMNS: Record<string, string> = {
  level: 'level',
  star: 'star',
  huayuan: 'huayuan',
  diamond: 'diamond',
  stamina: 'stamina',
  flower_sign_tickets: 'flower_sign_tickets',
  total_merges: 'total_merges',
  total_orders: 'total_orders',
  tutorial_step: 'tutorial_step',
  unlocked_deco_count: 'unlocked_deco_count',
  collection_discovered_count: 'collection_discovered_count',
  affinity_card_owned_count: 'affinity_card_owned_count',
  last_active_at: 'last_active_at',
  checkin_total_days: 'checkin_total_days',
  checkin_streak_days: 'checkin_streak_days',
};

export interface PlayerListItem {
  user_id: string;
  platform: string;
  level: number;
  star: number;
  huayuan: number;
  diamond: number;
  stamina: number;
  flower_sign_tickets: number;
  tutorial_step: number;
  tutorial_completed: 0 | 1;
  total_merges: number;
  total_orders: number;
  checkin_total_days: number;
  checkin_streak_days: number;
  unlocked_deco_count: number;
  collection_discovered_count: number;
  affinity_card_owned_count: number;
  active_customer_count: number;
  last_active_at: number;
}

export interface PlayerListQuery {
  snapshot_date?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
  /** 模糊匹配 user_id（前端搜索框输入的子串） */
  user_id_search?: string;
  /** 平台精确匹配：wx / h5 / dy / anon ... */
  platform?: string;
  /** 教程完成态精确过滤；undefined 表示不过滤 */
  tutorial_completed?: 0 | 1;
  /** 等级范围（含两端） */
  min_level?: number;
  max_level?: number;
  /** 花愿存量下限（含） */
  min_huayuan?: number;
}

export interface PlayerListResult {
  items: PlayerListItem[];
  total: number;
  page: number;
  page_size: number;
  query: {
    snapshot_date: string;
    sort: string;
    order: 'asc' | 'desc';
    filters: {
      user_id_search: string;
      platform: string | null;
      tutorial_completed: 0 | 1 | null;
      min_level: number | null;
      max_level: number | null;
      min_huayuan: number | null;
    };
  };
}

/**
 * 玩家明细分页查询：受控排序 + 受控筛选 + 关键字搜索 + 分页。
 *
 * 安全约束：
 *   - sort 字段必须命中白名单（SORTABLE_COLUMNS），其它一律视为非法
 *   - 所有 WHERE 条件用 ? placeholder（不拼接），杜绝 SQL 注入
 *   - page_size 上限 200（避免一次查询拖死后端）
 *
 * 平台前缀提示：huahua_playerData.userId 形如 'wx:xxx' / 'h5:xxx' / 'anon:xxx'，
 * 平台筛选用前缀匹配（'wx:%'）而不是精确匹配 platform 列，因为 platform 列在某些
 * 老档里写的是 'wx' 而新档可能是 'wechat'，userId 前缀更稳定。
 */
export async function listHuahuaPlayerSnapshots(
  gameKey: string,
  query: PlayerListQuery,
): Promise<PlayerListResult> {
  ensureMysql();
  ensureSupported(gameKey);
  const pool = await getMysqlPool();

  // 默认快照日期：最新一次拉到的
  let snapshotDate = (query.snapshot_date || '').trim();
  if (!snapshotDate) {
    const meta = await getLatestSnapshotMeta(gameKey);
    snapshotDate = meta?.snapshot_date || '';
  }

  // 排序：白名单 + 二级稳定排序（user_id 升序，分页结果稳定）
  const sortKey = query.sort && SORTABLE_COLUMNS[query.sort] ? SORTABLE_COLUMNS[query.sort] : 'last_active_at';
  const order: 'asc' | 'desc' = query.order === 'asc' ? 'asc' : 'desc';

  // 分页
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(query.page_size) || 50)));
  const offset = (page - 1) * pageSize;

  // 筛选条件
  const whereParts: string[] = ['snapshot_date = ?'];
  const whereParams: any[] = [snapshotDate];

  const userIdSearch = (query.user_id_search || '').trim();
  if (userIdSearch) {
    // % 转义防止用户输入 '%' 把 LIKE 玩坏；user_id 子串模糊匹配
    const escaped = userIdSearch.replace(/[\\%_]/g, (m) => `\\${m}`);
    whereParts.push('user_id LIKE ?');
    whereParams.push(`%${escaped}%`);
  }

  const platform = (query.platform || '').trim();
  if (platform) {
    // 平台用 user_id 前缀匹配，比 platform 列稳定（老档写 'wx' 新档写 'wechat'）
    whereParts.push('user_id LIKE ?');
    whereParams.push(`${platform}:%`);
  }

  if (query.tutorial_completed === 0 || query.tutorial_completed === 1) {
    whereParts.push('tutorial_completed = ?');
    whereParams.push(query.tutorial_completed);
  }

  if (typeof query.min_level === 'number' && Number.isFinite(query.min_level)) {
    whereParts.push('level >= ?');
    whereParams.push(query.min_level);
  }
  if (typeof query.max_level === 'number' && Number.isFinite(query.max_level)) {
    whereParts.push('level <= ?');
    whereParams.push(query.max_level);
  }
  if (typeof query.min_huayuan === 'number' && Number.isFinite(query.min_huayuan)) {
    whereParts.push('huayuan >= ?');
    whereParams.push(query.min_huayuan);
  }

  const whereSql = whereParts.join(' AND ');

  // 没有快照日期 → 直接返回空结果（避免无谓查询）
  if (!snapshotDate) {
    return {
      items: [],
      total: 0,
      page,
      page_size: pageSize,
      query: {
        snapshot_date: '',
        sort: sortKey,
        order,
        filters: {
          user_id_search: userIdSearch,
          platform: platform || null,
          tutorial_completed: query.tutorial_completed === 0 || query.tutorial_completed === 1 ? query.tutorial_completed : null,
          min_level: typeof query.min_level === 'number' ? query.min_level : null,
          max_level: typeof query.max_level === 'number' ? query.max_level : null,
          min_huayuan: typeof query.min_huayuan === 'number' ? query.min_huayuan : null,
        },
      },
    };
  }

  // 总数 + 列表两次查询并行（同 pool 同 connection 池，效率 OK）
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM ${snapshotTable(gameKey)} WHERE ${whereSql}`,
    whereParams,
  );
  const total = Number((countRows as Array<{ cnt: number }>)[0]?.cnt || 0);

  // ORDER BY 用反引号包列名，二级 user_id ASC 保证翻页结果稳定
  const [rows] = await pool.query(
    `SELECT user_id, platform, level, star, huayuan, diamond, stamina, flower_sign_tickets,
            tutorial_step, tutorial_completed, total_merges, total_orders,
            checkin_total_days, checkin_streak_days,
            unlocked_deco_count, collection_discovered_count,
            affinity_card_owned_count, active_customer_count, last_active_at
       FROM ${snapshotTable(gameKey)}
      WHERE ${whereSql}
      ORDER BY \`${sortKey}\` ${order === 'asc' ? 'ASC' : 'DESC'}, user_id ASC
      LIMIT ? OFFSET ?`,
    [...whereParams, pageSize, offset],
  );

  const items = (rows as any[]).map((r) => ({
    user_id: String(r.user_id),
    platform: String(r.platform || ''),
    level: Number(r.level),
    star: Number(r.star),
    huayuan: Number(r.huayuan),
    diamond: Number(r.diamond),
    stamina: Number(r.stamina),
    flower_sign_tickets: Number(r.flower_sign_tickets),
    tutorial_step: Number(r.tutorial_step),
    tutorial_completed: (Number(r.tutorial_completed) === 1 ? 1 : 0) as 0 | 1,
    total_merges: Number(r.total_merges),
    total_orders: Number(r.total_orders),
    checkin_total_days: Number(r.checkin_total_days),
    checkin_streak_days: Number(r.checkin_streak_days),
    unlocked_deco_count: Number(r.unlocked_deco_count),
    collection_discovered_count: Number(r.collection_discovered_count),
    affinity_card_owned_count: Number(r.affinity_card_owned_count),
    active_customer_count: Number(r.active_customer_count),
    last_active_at: Number(r.last_active_at),
  }));

  return {
    items,
    total,
    page,
    page_size: pageSize,
    query: {
      snapshot_date: snapshotDate,
      sort: sortKey,
      order,
      filters: {
        user_id_search: userIdSearch,
        platform: platform || null,
        tutorial_completed: query.tutorial_completed === 0 || query.tutorial_completed === 1 ? query.tutorial_completed : null,
        min_level: typeof query.min_level === 'number' ? query.min_level : null,
        max_level: typeof query.max_level === 'number' ? query.max_level : null,
        min_huayuan: typeof query.min_huayuan === 'number' ? query.min_huayuan : null,
      },
    },
  };
}

// ============================================================
// 主入口
// ============================================================

export async function getHuahuaSnapshotOverview(
  gameKey: string,
  snapshotDate?: string,
): Promise<SnapshotResult> {
  ensureMysql();
  ensureSupported(gameKey);

  // 没传 date：默认最新一次拉到的日期；表空时返回 null kpi（前端按"没有数据"处理）
  let date = snapshotDate || '';
  let userCount = 0;
  if (!date) {
    const meta = await getLatestSnapshotMeta(gameKey);
    if (!meta) {
      return {
        query: { game_key: gameKey, snapshot_date: '', has_data: false },
        kpi: null,
        level_distribution: [],
        huayuan_buckets: [],
        diamond_buckets: [],
        deco_buckets: [],
        tutorial_steps: [],
        daily_trend: [],
        latest_run: null,
      };
    }
    date = meta.snapshot_date;
    userCount = meta.user_count;
  }

  const [kpi, levels, huayuanB, diamondB, decoB, tutorial, trend] = await Promise.all([
    computeKpi(gameKey, date),
    computeLevelDistribution(gameKey, date),
    computeValueBuckets(gameKey, date, 'huayuan', HUAYUAN_BOUNDARIES),
    computeValueBuckets(gameKey, date, 'diamond', DIAMOND_BOUNDARIES),
    computeValueBuckets(gameKey, date, 'unlocked_deco_count', DECO_BOUNDARIES),
    computeTutorialSteps(gameKey, date),
    computeDailyTrend(gameKey, date),
  ]);
  const meta = await getLatestSnapshotMeta(gameKey);

  return {
    query: {
      game_key: gameKey,
      snapshot_date: date,
      has_data: (kpi?.user_count ?? userCount) > 0,
    },
    kpi,
    level_distribution: levels,
    huayuan_buckets: huayuanB,
    diamond_buckets: diamondB,
    deco_buckets: decoB,
    tutorial_steps: tutorial,
    daily_trend: trend,
    latest_run: meta?.latest_run || null,
  };
}

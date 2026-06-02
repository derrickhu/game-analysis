/**
 * 别捞水果（hotpot）玩家档案快照聚合查询
 */

import { getMysqlPool, isMysqlMode } from '../db';
import { getLatestSnapshotMeta, type PlayerSnapshotRun } from '../snapshot-db';

const SUPPORTED_GAMES = new Set(['hotpot']);

function ensureSupported(gameKey: string): void {
  if (!SUPPORTED_GAMES.has(gameKey)) {
    throw new Error(`hotpot 快照看板暂不支持 ${gameKey}`);
  }
}

function snapshotTable(gameKey: string): string {
  ensureSupported(gameKey);
  return `\`hotpot_player_snapshots\``;
}

function ensureMysql(): void {
  if (!isMysqlMode()) {
    throw new Error('snapshot 看板只支持 MySQL');
  }
}

export interface HotpotSnapshotKpi {
  user_count: number;
  avg_coins: number;
  max_coins: number;
  median_coins: number;
  avg_coins_earned: number;
  avg_coins_spent: number;
  avg_bowl_badge_level: number;
  max_bowl_badge_level: number;
  avg_fruit_best_score: number;
  max_fruit_best_score: number;
  avg_gacha_pulls: number;
  avg_bowl_tool_total: number;
}

export interface LevelBucket {
  level: number;
  user_cnt: number;
}

export interface ValueBucket {
  bucket: string;
  user_cnt: number;
  min_value: number;
}

export interface DailyTrendPoint {
  date: string;
  user_count: number;
  avg_coins: number;
  avg_bowl_badge_level: number;
}

export interface HotpotSnapshotResult {
  query: {
    game_key: string;
    snapshot_date: string;
    has_data: boolean;
  };
  kpi: HotpotSnapshotKpi | null;
  bowl_level_distribution: LevelBucket[];
  coins_buckets: ValueBucket[];
  daily_trend: DailyTrendPoint[];
  latest_run?: PlayerSnapshotRun | null;
}

const COINS_BOUNDARIES = [0, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

function bucketize(value: number, boundaries: number[]): { bucket: string; min: number } {
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (value >= boundaries[i]! && value < boundaries[i + 1]!) {
      return { bucket: `${boundaries[i]}-${boundaries[i + 1]}`, min: boundaries[i]! };
    }
  }
  const last = boundaries[boundaries.length - 1] || 0;
  return { bucket: `≥${last}`, min: last };
}

function round0(n: number): number {
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

async function computeKpi(gameKey: string, snapshotDate: string): Promise<HotpotSnapshotKpi | null> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
       COUNT(*) AS user_count,
       AVG(coins) AS avg_coins,
       MAX(coins) AS max_coins,
       AVG(coins_total_earned) AS avg_coins_earned,
       AVG(coins_total_spent) AS avg_coins_spent,
       AVG(bowl_badge_level) AS avg_bowl_badge_level,
       MAX(bowl_badge_level) AS max_bowl_badge_level,
       AVG(fruit_slice_best_score) AS avg_fruit_best,
       MAX(fruit_slice_best_score) AS max_fruit_best,
       AVG(gacha_total_pulls) AS avg_gacha_pulls,
       AVG(bowl_tool_total) AS avg_bowl_tool_total
     FROM ${snapshotTable(gameKey)}
     WHERE snapshot_date = ?`,
    [snapshotDate],
  );
  const r = (rows as Array<Record<string, unknown>>)[0];
  if (!r || Number(r.user_count) === 0) return null;

  const [medianRows] = await pool.query(
    `SELECT coins AS v FROM ${snapshotTable(gameKey)} WHERE snapshot_date = ? ORDER BY coins`,
    [snapshotDate],
  );
  const coinList = (medianRows as Array<{ v: number }>).map((row) => Number(row.v));
  let medianCoins = 0;
  if (coinList.length > 0) {
    const mid = coinList.length >> 1;
    medianCoins = coinList.length % 2 === 0
      ? (coinList[mid - 1]! + coinList[mid]!) / 2
      : coinList[mid]!;
  }

  return {
    user_count: Number(r.user_count),
    avg_coins: round0(Number(r.avg_coins)),
    max_coins: round0(Number(r.max_coins)),
    median_coins: round0(medianCoins),
    avg_coins_earned: round0(Number(r.avg_coins_earned)),
    avg_coins_spent: round0(Number(r.avg_coins_spent)),
    avg_bowl_badge_level: round1(Number(r.avg_bowl_badge_level)),
    max_bowl_badge_level: Number(r.max_bowl_badge_level || 0),
    avg_fruit_best_score: round0(Number(r.avg_fruit_best)),
    max_fruit_best_score: round0(Number(r.max_fruit_best)),
    avg_gacha_pulls: round1(Number(r.avg_gacha_pulls)),
    avg_bowl_tool_total: round1(Number(r.avg_bowl_tool_total)),
  };
}

async function computeBowlLevelDistribution(gameKey: string, snapshotDate: string): Promise<LevelBucket[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT bowl_badge_level AS level, COUNT(*) AS cnt
       FROM ${snapshotTable(gameKey)}
      WHERE snapshot_date = ?
      GROUP BY bowl_badge_level
      ORDER BY bowl_badge_level ASC`,
    [snapshotDate],
  );
  return (rows as Array<{ level: number; cnt: number }>).map((r) => ({
    level: Number(r.level),
    user_cnt: Number(r.cnt),
  }));
}

async function computeCoinsBuckets(gameKey: string, snapshotDate: string): Promise<ValueBucket[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT coins AS v FROM ${snapshotTable(gameKey)} WHERE snapshot_date = ?`,
    [snapshotDate],
  );
  const counts = new Map<string, { cnt: number; min: number }>();
  for (const r of rows as Array<{ v: number }>) {
    const v = Number(r.v);
    const { bucket, min } = bucketize(v, COINS_BOUNDARIES);
    if (!counts.has(bucket)) counts.set(bucket, { cnt: 0, min });
    counts.get(bucket)!.cnt++;
  }
  return Array.from(counts.entries())
    .map(([bucket, { cnt, min }]) => ({ bucket, user_cnt: cnt, min_value: min }))
    .sort((a, b) => a.min_value - b.min_value);
}

async function computeDailyTrend(gameKey: string, snapshotDate: string): Promise<DailyTrendPoint[]> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
       snapshot_date,
       COUNT(*) AS user_count,
       AVG(coins) AS avg_coins,
       AVG(bowl_badge_level) AS avg_bowl_badge_level
     FROM ${snapshotTable(gameKey)}
     WHERE snapshot_date <= ?
     GROUP BY snapshot_date
     ORDER BY snapshot_date DESC
     LIMIT 30`,
    [snapshotDate],
  );
  return (rows as Array<Record<string, unknown>>)
    .map((r) => ({
      date: String(r.snapshot_date),
      user_count: Number(r.user_count),
      avg_coins: round0(Number(r.avg_coins)),
      avg_bowl_badge_level: round1(Number(r.avg_bowl_badge_level)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const SORTABLE_COLUMNS: Record<string, string> = {
  coins: 'coins',
  coins_total_earned: 'coins_total_earned',
  coins_total_spent: 'coins_total_spent',
  bowl_badge_level: 'bowl_badge_level',
  bowl_play_level_index: 'bowl_play_level_index',
  fruit_slice_best_score: 'fruit_slice_best_score',
  fruit_slice_total_runs: 'fruit_slice_total_runs',
  gacha_total_pulls: 'gacha_total_pulls',
  bowl_tool_total: 'bowl_tool_total',
  milk_tea_shop_level: 'milk_tea_shop_level',
  milk_tea_total_clears: 'milk_tea_total_clears',
  last_active_at: 'last_active_at',
};

export interface HotpotPlayerListItem {
  user_id: string;
  platform: string;
  coins: number;
  coins_total_earned: number;
  coins_total_spent: number;
  bowl_badge_level: number;
  bowl_play_level_index: number;
  fruit_slice_best_score: number;
  fruit_slice_total_runs: number;
  gacha_total_pulls: number;
  bowl_tool_total: number;
  milk_tea_shop_level: number;
  milk_tea_total_clears: number;
  last_active_at: number;
}

export interface HotpotPlayerListQuery {
  snapshot_date?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
  user_id_search?: string;
  platform?: string;
  min_coins?: number;
  max_coins?: number;
  min_bowl_level?: number;
}

export interface HotpotPlayerListResult {
  items: HotpotPlayerListItem[];
  total: number;
  page: number;
  page_size: number;
  query: {
    snapshot_date: string;
    sort: string;
    order: 'asc' | 'desc';
  };
}

export async function listHotpotPlayerSnapshots(
  gameKey: string,
  query: HotpotPlayerListQuery,
): Promise<HotpotPlayerListResult> {
  ensureMysql();
  ensureSupported(gameKey);
  const pool = await getMysqlPool();

  let snapshotDate = (query.snapshot_date || '').trim();
  if (!snapshotDate) {
    const meta = await getLatestSnapshotMeta(gameKey);
    snapshotDate = meta?.snapshot_date || '';
  }

  const sortKey = query.sort && SORTABLE_COLUMNS[query.sort] ? SORTABLE_COLUMNS[query.sort] : 'coins';
  const order: 'asc' | 'desc' = query.order === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(query.page_size) || 50)));
  const offset = (page - 1) * pageSize;

  const where: string[] = ['snapshot_date = ?'];
  const params: unknown[] = [snapshotDate];

  const userIdSearch = (query.user_id_search || '').trim();
  if (userIdSearch) {
    where.push('user_id LIKE ?');
    params.push(`%${userIdSearch}%`);
  }
  if (query.platform) {
    where.push('(platform = ? OR user_id LIKE ?)');
    params.push(query.platform, `${query.platform}:%`);
  }
  if (typeof query.min_coins === 'number' && Number.isFinite(query.min_coins)) {
    where.push('coins >= ?');
    params.push(query.min_coins);
  }
  if (typeof query.max_coins === 'number' && Number.isFinite(query.max_coins)) {
    where.push('coins <= ?');
    params.push(query.max_coins);
  }
  if (typeof query.min_bowl_level === 'number' && Number.isFinite(query.min_bowl_level)) {
    where.push('bowl_badge_level >= ?');
    params.push(query.min_bowl_level);
  }

  const whereSql = where.join(' AND ');
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM ${snapshotTable(gameKey)} WHERE ${whereSql}`,
    params,
  );
  const total = Number((countRows as Array<{ cnt: number }>)[0]?.cnt || 0);

  const [items] = await pool.query(
    `SELECT user_id, platform, coins, coins_total_earned, coins_total_spent,
            bowl_badge_level, bowl_play_level_index,
            fruit_slice_best_score, fruit_slice_total_runs,
            gacha_total_pulls, bowl_tool_total,
            milk_tea_shop_level, milk_tea_total_clears,
            last_active_at
       FROM ${snapshotTable(gameKey)}
      WHERE ${whereSql}
      ORDER BY \`${sortKey}\` ${order}, user_id ASC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return {
    items: (items as HotpotPlayerListItem[]).map((r) => ({
      user_id: String(r.user_id),
      platform: String(r.platform || ''),
      coins: Number(r.coins),
      coins_total_earned: Number(r.coins_total_earned),
      coins_total_spent: Number(r.coins_total_spent),
      bowl_badge_level: Number(r.bowl_badge_level),
      bowl_play_level_index: Number(r.bowl_play_level_index),
      fruit_slice_best_score: Number(r.fruit_slice_best_score),
      fruit_slice_total_runs: Number(r.fruit_slice_total_runs),
      gacha_total_pulls: Number(r.gacha_total_pulls),
      bowl_tool_total: Number(r.bowl_tool_total),
      milk_tea_shop_level: Number(r.milk_tea_shop_level),
      milk_tea_total_clears: Number(r.milk_tea_total_clears),
      last_active_at: Number(r.last_active_at),
    })),
    total,
    page,
    page_size: pageSize,
    query: { snapshot_date: snapshotDate, sort: sortKey, order },
  };
}

export async function getHotpotSnapshotOverview(
  gameKey: string,
  snapshotDate?: string,
): Promise<HotpotSnapshotResult> {
  ensureMysql();
  ensureSupported(gameKey);

  let date = snapshotDate || '';
  if (!date) {
    const meta = await getLatestSnapshotMeta(gameKey);
    if (!meta) {
      return {
        query: { game_key: gameKey, snapshot_date: '', has_data: false },
        kpi: null,
        bowl_level_distribution: [],
        coins_buckets: [],
        daily_trend: [],
        latest_run: null,
      };
    }
    date = meta.snapshot_date;
  }

  const [kpi, bowlLevels, coinsBuckets, trend] = await Promise.all([
    computeKpi(gameKey, date),
    computeBowlLevelDistribution(gameKey, date),
    computeCoinsBuckets(gameKey, date),
    computeDailyTrend(gameKey, date),
  ]);
  const meta = await getLatestSnapshotMeta(gameKey);

  return {
    query: {
      game_key: gameKey,
      snapshot_date: date,
      has_data: (kpi?.user_count ?? 0) > 0,
    },
    kpi,
    bowl_level_distribution: bowlLevels,
    coins_buckets: coinsBuckets,
    daily_trend: trend,
    latest_run: meta?.latest_run || null,
  };
}

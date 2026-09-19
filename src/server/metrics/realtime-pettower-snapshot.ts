/**
 * 灵宠消消塔2（petTower）玩家档案快照聚合查询
 */

import { platformToSnapshotPrefix, playerDataCollection } from '../../shared/platforms';
import { getMysqlPool, isMysqlMode } from '../db';
import { getLatestSnapshotMeta, type PlayerSnapshotRun } from '../snapshot-db';

const SUPPORTED_GAMES = new Set(['petTower']);
const SNAPSHOT_PREFIXES = new Set(['wx', 'dy', 'tap', 'hw', 'h5', 'anon']);

function ensureSupported(gameKey: string): void {
  if (!SUPPORTED_GAMES.has(gameKey)) {
    throw new Error(`petTower 快照看板暂不支持 ${gameKey}`);
  }
}

function snapshotTable(gameKey: string): string {
  ensureSupported(gameKey);
  return `\`petTower_player_snapshots\``;
}

function ensureMysql(): void {
  if (!isMysqlMode()) {
    throw new Error('snapshot 看板只支持 MySQL');
  }
}

function resolveSnapshotUserPrefix(platform?: string): string {
  const raw = (platform || '').trim().toLowerCase();
  if (!raw) return '';
  if (SNAPSHOT_PREFIXES.has(raw)) return raw;
  return platformToSnapshotPrefix(raw);
}

function platformWhere(platform?: string): { sql: string; params: string[] } {
  const prefix = resolveSnapshotUserPrefix(platform);
  if (!prefix) return { sql: '', params: [] };
  return { sql: ' AND user_id LIKE ?', params: [`${prefix}:%`] };
}

export interface PetTowerSnapshotKpi {
  user_count: number;
  avg_coins: number;
  max_coins: number;
  avg_lingyu: number;
  max_lingyu: number;
  avg_tickets: number;
  avg_stamina: number;
  avg_owned_pets: number;
  avg_max_pet_level: number;
  avg_stage_clears: number;
  max_chapter: number;
  avg_tower_floor: number;
  max_tower_floor: number;
  tutorial_home_rate: number | null;
  tutorial_drag_rate: number | null;
  sidebar_claimed_rate: number | null;
  checkin_active_rate: number | null;
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
  avg_lingyu: number;
  avg_stage_clears: number;
  avg_tower_floor: number;
}

export interface PetTowerSnapshotResult {
  query: {
    game_key: string;
    snapshot_date: string;
    has_data: boolean;
  };
  kpi: PetTowerSnapshotKpi | null;
  chapter_distribution: LevelBucket[];
  coins_buckets: ValueBucket[];
  lingyu_buckets: ValueBucket[];
  tower_buckets: ValueBucket[];
  daily_trend: DailyTrendPoint[];
  latest_run?: PlayerSnapshotRun | null;
}

const COINS_BOUNDARIES = [0, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const LINGYU_BOUNDARIES = [0, 10, 30, 60, 100, 200, 500, 1000, 5000];
const TOWER_BOUNDARIES = [0, 1, 5, 10, 20, 30, 50, 80];

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

function rateOf(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((part / total) * 1000) / 1000;
}

async function computeKpi(
  gameKey: string,
  snapshotDate: string,
  platform?: string,
): Promise<PetTowerSnapshotKpi | null> {
  const pool = await getMysqlPool();
  const pf = platformWhere(platform);
  const [rows] = await pool.query(
    `SELECT
       COUNT(*) AS user_count,
       AVG(coins) AS avg_coins,
       MAX(coins) AS max_coins,
       AVG(lingyu) AS avg_lingyu,
       MAX(lingyu) AS max_lingyu,
       AVG(tickets) AS avg_tickets,
       AVG(stamina) AS avg_stamina,
       AVG(owned_pet_count) AS avg_owned_pets,
       AVG(max_pet_level) AS avg_max_pet_level,
       AVG(stage_clear_count) AS avg_stage_clears,
       MAX(max_chapter) AS max_chapter,
       AVG(tower_best_floor) AS avg_tower_floor,
       MAX(tower_best_floor) AS max_tower_floor,
       SUM(tutorial_home_done) AS tutorial_home_done,
       SUM(tutorial_drag_done) AS tutorial_drag_done,
       SUM(sidebar_claimed) AS sidebar_claimed,
       SUM(CASE WHEN checkin_total_days > 0 THEN 1 ELSE 0 END) AS checkin_active
     FROM ${snapshotTable(gameKey)}
     WHERE snapshot_date = ?${pf.sql}`,
    [snapshotDate, ...pf.params],
  );
  const r = (rows as Array<Record<string, unknown>>)[0];
  if (!r || Number(r.user_count) === 0) return null;

  const userCount = Number(r.user_count);
  return {
    user_count: userCount,
    avg_coins: round0(Number(r.avg_coins)),
    max_coins: round0(Number(r.max_coins)),
    avg_lingyu: round0(Number(r.avg_lingyu)),
    max_lingyu: round0(Number(r.max_lingyu)),
    avg_tickets: round1(Number(r.avg_tickets)),
    avg_stamina: round1(Number(r.avg_stamina)),
    avg_owned_pets: round1(Number(r.avg_owned_pets)),
    avg_max_pet_level: round1(Number(r.avg_max_pet_level)),
    avg_stage_clears: round1(Number(r.avg_stage_clears)),
    max_chapter: Number(r.max_chapter || 0),
    avg_tower_floor: round1(Number(r.avg_tower_floor)),
    max_tower_floor: Number(r.max_tower_floor || 0),
    tutorial_home_rate: rateOf(Number(r.tutorial_home_done), userCount),
    tutorial_drag_rate: rateOf(Number(r.tutorial_drag_done), userCount),
    sidebar_claimed_rate: rateOf(Number(r.sidebar_claimed), userCount),
    checkin_active_rate: rateOf(Number(r.checkin_active), userCount),
  };
}

async function computeChapterDistribution(
  gameKey: string,
  snapshotDate: string,
  platform?: string,
): Promise<LevelBucket[]> {
  const pool = await getMysqlPool();
  const pf = platformWhere(platform);
  const [rows] = await pool.query(
    `SELECT max_chapter AS level, COUNT(*) AS cnt
       FROM ${snapshotTable(gameKey)}
      WHERE snapshot_date = ?${pf.sql}
      GROUP BY max_chapter
      ORDER BY max_chapter ASC`,
    [snapshotDate, ...pf.params],
  );
  return (rows as Array<{ level: number; cnt: number }>).map((r) => ({
    level: Number(r.level),
    user_cnt: Number(r.cnt),
  }));
}

async function computeValueBuckets(
  gameKey: string,
  snapshotDate: string,
  column: 'coins' | 'lingyu' | 'tower_best_floor',
  boundaries: number[],
  platform?: string,
): Promise<ValueBucket[]> {
  const pool = await getMysqlPool();
  const pf = platformWhere(platform);
  const [rows] = await pool.query(
    `SELECT ${column} AS v FROM ${snapshotTable(gameKey)} WHERE snapshot_date = ?${pf.sql}`,
    [snapshotDate, ...pf.params],
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

async function computeDailyTrend(
  gameKey: string,
  snapshotDate: string,
  platform?: string,
): Promise<DailyTrendPoint[]> {
  const pool = await getMysqlPool();
  const pf = platformWhere(platform);
  const [rows] = await pool.query(
    `SELECT
       snapshot_date,
       COUNT(*) AS user_count,
       AVG(coins) AS avg_coins,
       AVG(lingyu) AS avg_lingyu,
       AVG(stage_clear_count) AS avg_stage_clears,
       AVG(tower_best_floor) AS avg_tower_floor
     FROM ${snapshotTable(gameKey)}
     WHERE snapshot_date <= ?${pf.sql}
     GROUP BY snapshot_date
     ORDER BY snapshot_date DESC
     LIMIT 30`,
    [snapshotDate, ...pf.params],
  );
  return (rows as Array<Record<string, unknown>>)
    .map((r) => ({
      date: String(r.snapshot_date),
      user_count: Number(r.user_count),
      avg_coins: round0(Number(r.avg_coins)),
      avg_lingyu: round0(Number(r.avg_lingyu)),
      avg_stage_clears: round1(Number(r.avg_stage_clears)),
      avg_tower_floor: round1(Number(r.avg_tower_floor)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const SORTABLE_COLUMNS: Record<string, string> = {
  coins: 'coins',
  lingyu: 'lingyu',
  tickets: 'tickets',
  stamina: 'stamina',
  owned_pet_count: 'owned_pet_count',
  max_pet_level: 'max_pet_level',
  max_pet_star: 'max_pet_star',
  recruited_count: 'recruited_count',
  stage_clear_count: 'stage_clear_count',
  max_chapter: 'max_chapter',
  tower_best_floor: 'tower_best_floor',
  checkin_total_days: 'checkin_total_days',
  last_active_at: 'last_active_at',
};

export interface PetTowerPlayerListItem {
  user_id: string;
  platform: string;
  coins: number;
  lingyu: number;
  tickets: number;
  stamina: number;
  owned_pet_count: number;
  max_pet_level: number;
  max_pet_star: number;
  recruited_count: number;
  stage_clear_count: number;
  max_chapter: number;
  tower_best_floor: number;
  checkin_total_days: number;
  tutorial_home_done: number;
  tutorial_drag_done: number;
  sidebar_claimed: number;
  last_active_at: number;
}

export interface PetTowerPlayerListQuery {
  snapshot_date?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
  user_id_search?: string;
  platform?: string;
  min_coins?: number;
  max_coins?: number;
  min_clears?: number;
  min_tower_floor?: number;
}

export interface PetTowerPlayerListResult {
  items: PetTowerPlayerListItem[];
  total: number;
  page: number;
  page_size: number;
  query: {
    snapshot_date: string;
    sort: string;
    order: 'asc' | 'desc';
  };
}

export async function listPetTowerPlayerSnapshots(
  gameKey: string,
  query: PetTowerPlayerListQuery,
): Promise<PetTowerPlayerListResult> {
  ensureMysql();
  ensureSupported(gameKey);
  const pool = await getMysqlPool();

  let snapshotDate = (query.snapshot_date || '').trim();
  if (!snapshotDate) {
    const meta = await getLatestSnapshotMeta(gameKey);
    snapshotDate = meta?.snapshot_date || '';
  }

  const sortKey = query.sort && SORTABLE_COLUMNS[query.sort] ? SORTABLE_COLUMNS[query.sort] : 'stage_clear_count';
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
  if (typeof query.min_clears === 'number' && Number.isFinite(query.min_clears)) {
    where.push('stage_clear_count >= ?');
    params.push(query.min_clears);
  }
  if (typeof query.min_tower_floor === 'number' && Number.isFinite(query.min_tower_floor)) {
    where.push('tower_best_floor >= ?');
    params.push(query.min_tower_floor);
  }

  const whereSql = where.join(' AND ');
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM ${snapshotTable(gameKey)} WHERE ${whereSql}`,
    params,
  );
  const total = Number((countRows as Array<{ cnt: number }>)[0]?.cnt || 0);

  const [items] = await pool.query(
    `SELECT user_id, platform, coins, lingyu, tickets, stamina,
            owned_pet_count, max_pet_level, max_pet_star, recruited_count,
            stage_clear_count, max_chapter, tower_best_floor,
            checkin_total_days, tutorial_home_done, tutorial_drag_done,
            sidebar_claimed, last_active_at
       FROM ${snapshotTable(gameKey)}
      WHERE ${whereSql}
      ORDER BY \`${sortKey}\` ${order}, user_id ASC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return {
    items: (items as PetTowerPlayerListItem[]).map((r) => ({
      user_id: String(r.user_id),
      platform: String(r.platform || ''),
      coins: Number(r.coins),
      lingyu: Number(r.lingyu),
      tickets: Number(r.tickets),
      stamina: Number(r.stamina),
      owned_pet_count: Number(r.owned_pet_count),
      max_pet_level: Number(r.max_pet_level),
      max_pet_star: Number(r.max_pet_star),
      recruited_count: Number(r.recruited_count),
      stage_clear_count: Number(r.stage_clear_count),
      max_chapter: Number(r.max_chapter),
      tower_best_floor: Number(r.tower_best_floor),
      checkin_total_days: Number(r.checkin_total_days),
      tutorial_home_done: Number(r.tutorial_home_done),
      tutorial_drag_done: Number(r.tutorial_drag_done),
      sidebar_claimed: Number(r.sidebar_claimed),
      last_active_at: Number(r.last_active_at),
    })),
    total,
    page,
    page_size: pageSize,
    query: { snapshot_date: snapshotDate, sort: sortKey, order },
  };
}

export async function getPetTowerSnapshotOverview(
  gameKey: string,
  snapshotDate?: string,
  platform?: string,
): Promise<PetTowerSnapshotResult> {
  ensureMysql();
  ensureSupported(gameKey);

  const userPrefix = resolveSnapshotUserPrefix(platform);
  const collectionName = playerDataCollection(gameKey, platform);

  let date = snapshotDate || '';
  if (!date) {
    const meta = await getLatestSnapshotMeta(gameKey, {
      userIdPrefix: userPrefix || undefined,
      collectionName,
    });
    if (!meta) {
      return {
        query: { game_key: gameKey, snapshot_date: '', has_data: false },
        kpi: null,
        chapter_distribution: [],
        coins_buckets: [],
        lingyu_buckets: [],
        tower_buckets: [],
        daily_trend: [],
        latest_run: null,
      };
    }
    date = meta.snapshot_date;
  }

  const [kpi, chapters, coinsBuckets, lingyuBuckets, towerBuckets, trend] = await Promise.all([
    computeKpi(gameKey, date, platform),
    computeChapterDistribution(gameKey, date, platform),
    computeValueBuckets(gameKey, date, 'coins', COINS_BOUNDARIES, platform),
    computeValueBuckets(gameKey, date, 'lingyu', LINGYU_BOUNDARIES, platform),
    computeValueBuckets(gameKey, date, 'tower_best_floor', TOWER_BOUNDARIES, platform),
    computeDailyTrend(gameKey, date, platform),
  ]);
  const meta = await getLatestSnapshotMeta(gameKey, {
    userIdPrefix: userPrefix || undefined,
    collectionName,
  });

  return {
    query: {
      game_key: gameKey,
      snapshot_date: date,
      has_data: (kpi?.user_count ?? 0) > 0,
    },
    kpi,
    chapter_distribution: chapters,
    coins_buckets: coinsBuckets,
    lingyu_buckets: lingyuBuckets,
    tower_buckets: towerBuckets,
    daily_trend: trend,
    latest_run: meta?.latest_run || null,
  };
}

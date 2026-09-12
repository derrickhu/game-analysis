/**
 * 灵宠消消塔2（petTower）专属玩法聚合。
 *
 * 隔离约定：
 * - 只读 game_key = petTower 的事件，路由层再锁一次，其它游戏调这个接口会 400
 * - 不改 level-progress / huahua / hotpot / caizhu 的 SQL 或面板
 * - 通天塔层号、印记、重置、兑换只在这里解释，避免共享关卡漏斗把 tower_fN 当成「第 0 关」
 *
 * session_end 目前只有 {reason}，没有 duration_ms。时长用「同一用户相邻事件间隔 ≤ 5 分钟」
 * 拼成会话，和 LTV 表里那列永远为 0 的 session_duration_ms 不是同一口径。
 */
import { getEstimatedEcpm } from '../config/ecpm';
import { getMysqlPool } from '../db';
import { PLATFORM_SQL, platformSqlParams } from './platform-filter';

export const PET_TOWER_GAME_KEY = 'petTower';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
const IDLE_GAP_MS = 5 * 60_000;
const MIN_SESSION_MS = 15_000;
/** 与 xiaochu2 TOWER_EXCHANGES.tex_coins.cost 对齐，只作看板换算，不反向改游戏数值 */
const SHOP_COIN_PACK_MARKS = 40;
const DIFFICULTY_BASE = 0.9;
const DIFFICULTY_GROWTH = 1.033;
const MILESTONE_EVERY = 10;
const MILESTONE_DIFF_MULT = 1.25;

interface AnalyticsRow {
  event_name: string;
  event_ts: number;
  uk: string;
  params_json: unknown;
}

export interface PetTowerSessionBucket {
  range_label: string;
  count: number;
}

export interface PetTowerDailyPoint {
  date_key: string;
  dau: number;
  play_minutes: number;
  minutes_per_user: number;
  session_cnt: number;
  ad_show_cnt: number;
  ad_revenue_estimated_cny: number;
  tower_starts: number;
  tower_clears: number;
}

export interface PetTowerFloorBand {
  band_label: string;
  band_from: number;
  band_to: number;
  starts: number;
  clears: number;
  clear_rate: number | null;
  avg_coins: number;
  coins_sum: number;
  difficulty_mid: number;
}

export interface PetTowerFloorRow {
  floor: number;
  starts: number;
  clears: number;
  clear_rate: number | null;
  avg_coins: number;
  difficulty: number;
  is_wall: boolean;
}

export interface PetTowerBattleMode {
  mode: string;
  clears: number;
  avg_duration_ms: number;
  avg_turns: number;
}

export interface PetTowerAdScene {
  scene: string;
  shows: number;
  completes: number;
  complete_rate: number | null;
  revenue_estimated_cny: number;
}

export interface PetTowerExchangeRow {
  option_id: string;
  count: number;
  cost_sum: number;
}

export interface PetTowerGameplayOverview {
  kpi: {
    dau: number;
    play_users: number;
    session_cnt: number;
    play_minutes: number;
    avg_session_ms: number;
    median_session_ms: number;
    minutes_per_user: number;
    duration_source: 'reconstructed_idle_gap';
    ad_show_cnt: number;
    ad_complete_cnt: number;
    ad_revenue_estimated_cny: number;
    arpdau_estimated_cny: number;
    tower_start_cnt: number;
    tower_clear_cnt: number;
    tower_clear_rate: number | null;
    tower_reset_cnt: number;
    max_floor: number;
    computed_at: number;
  };
  mismatch: {
    tower_avg_clear_ms: number;
    mainline_avg_clear_ms: number;
    duration_ratio: number | null;
    late_band_label: string;
    late_band_avg_coins: number;
    late_band_clear_rate: number | null;
    shop_coin_pack_marks: number;
    tower_minutes_for_coin_pack: number | null;
    wall_floors: number[];
  };
  session_buckets: PetTowerSessionBucket[];
  daily: PetTowerDailyPoint[];
  floor_bands: PetTowerFloorBand[];
  wall_floors: PetTowerFloorRow[];
  battle_modes: PetTowerBattleMode[];
  ad_scenes: PetTowerAdScene[];
  exchanges: PetTowerExchangeRow[];
}

export async function getPetTowerGameplayOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<PetTowerGameplayOverview> {
  const rows = await listRows(gameKey, fromTs, toTs, platform);
  const sessions = reconstructSessions(rows);
  const playUsers = new Set(sessions.map((s) => s.uk));
  const dau = new Set(
    rows.filter((r) => r.event_name === 'session_start' && r.uk).map((r) => r.uk),
  ).size || playUsers.size;

  const durs = sessions.map((s) => s.dur).sort((a, b) => a - b);
  const playMs = durs.reduce((sum, v) => sum + v, 0);
  const adShows = rows.filter((r) => r.event_name === 'ad_show');
  const adCloses = rows.filter((r) => r.event_name === 'ad_close');
  const adRevenue = adShows.reduce((sum, row) => {
    const scene = strParam(row, 'scene', 'unknown');
    const adType = strParam(row, 'ad_type', 'reward');
    return sum + getEstimatedEcpm(gameKey, adType, scene) / 1000;
  }, 0);
  const adComplete = adCloses.filter((row) => boolParam(row, 'completed')).length;

  const towerStarts = rows.filter((r) => r.event_name === 'tower_floor_start');
  const towerClears = rows.filter((r) => r.event_name === 'tower_floor_clear');
  const battleModes = buildBattleModes(rows);
  const floorBands = buildFloorBands(towerStarts, towerClears);
  const wallFloors = buildFloorRows(towerStarts, towerClears).filter((row) => row.is_wall);
  const grindBand = pickGrindBand(floorBands);
  const towerBattle = battleModes.find((m) => m.mode === 'tower');
  const mainlineBattle = battleModes.find((m) => m.mode === 'mainline');
  // 兑换节奏看「卡住以后还能拿到多少」，不要用突破首通把场均印记拉高
  const wallCoins = wallFloors.length > 0
    ? avg(wallFloors.map((row) => row.avg_coins).filter((n) => n > 0))
    : 0;
  const grindCoins = wallCoins > 0 ? wallCoins : (grindBand?.avg_coins ?? 0);
  const towerMin = (towerBattle?.avg_duration_ms ?? 0) / 60_000;
  const minutesForPack = grindCoins > 0 && towerMin > 0
    ? (SHOP_COIN_PACK_MARKS / grindCoins) * towerMin
    : null;

  return {
    kpi: {
      dau,
      play_users: playUsers.size,
      session_cnt: sessions.length,
      play_minutes: round1(playMs / 60_000),
      avg_session_ms: avg(durs),
      median_session_ms: median(durs),
      minutes_per_user: playUsers.size > 0 ? round1(playMs / 60_000 / playUsers.size) : 0,
      duration_source: 'reconstructed_idle_gap',
      ad_show_cnt: adShows.length,
      ad_complete_cnt: adComplete,
      ad_revenue_estimated_cny: round2(adRevenue),
      arpdau_estimated_cny: dau > 0 ? round2(adRevenue / dau) : 0,
      tower_start_cnt: towerStarts.length,
      tower_clear_cnt: towerClears.length,
      tower_clear_rate: towerStarts.length > 0 ? towerClears.length / towerStarts.length : null,
      tower_reset_cnt: rows.filter((r) => r.event_name === 'tower_reset').length,
      max_floor: maxNum(towerClears, 'floor'),
      computed_at: Date.now(),
    },
    mismatch: {
      tower_avg_clear_ms: towerBattle?.avg_duration_ms ?? 0,
      mainline_avg_clear_ms: mainlineBattle?.avg_duration_ms ?? 0,
      duration_ratio: towerBattle && mainlineBattle && mainlineBattle.avg_duration_ms > 0
        ? round2(towerBattle.avg_duration_ms / mainlineBattle.avg_duration_ms)
        : null,
      late_band_label: grindBand?.band_label ?? '',
      late_band_avg_coins: round2(grindCoins),
      late_band_clear_rate: grindBand?.clear_rate ?? null,
      shop_coin_pack_marks: SHOP_COIN_PACK_MARKS,
      tower_minutes_for_coin_pack: minutesForPack === null ? null : round1(minutesForPack),
      wall_floors: wallFloors.map((row) => row.floor),
    },
    session_buckets: buildSessionBuckets(durs),
    daily: buildDaily(rows, sessions, gameKey),
    floor_bands: floorBands,
    wall_floors: wallFloors,
    battle_modes: battleModes,
    ad_scenes: buildAdScenes(adShows, adCloses, gameKey),
    exchanges: buildExchanges(rows.filter((r) => r.event_name === 'tower_exchange')),
  };
}

async function listRows(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<AnalyticsRow[]> {
  const platformParams = platformSqlParams(platform);
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT event_name, event_ts, ${USER_KEY_SQL} AS uk, params_json
       FROM analytics_events
      WHERE game_key = ?
        AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`,
    [gameKey, fromTs, toTs, ...platformParams],
  );
  return rows as AnalyticsRow[];
}

interface SessionSpan {
  uk: string;
  start: number;
  dur: number;
}

function reconstructSessions(rows: AnalyticsRow[]): SessionSpan[] {
  const byUser = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.uk) continue;
    const list = byUser.get(row.uk) || [];
    list.push(Number(row.event_ts) || 0);
    byUser.set(row.uk, list);
  }
  const sessions: SessionSpan[] = [];
  for (const [uk, times] of byUser) {
    times.sort((a, b) => a - b);
    let start = times[0] ?? 0;
    let last = start;
    for (let i = 1; i < times.length; i += 1) {
      const t = times[i] ?? last;
      if (t - last > IDLE_GAP_MS) {
        const dur = last - start;
        if (dur >= MIN_SESSION_MS) sessions.push({ uk, start, dur });
        start = t;
      }
      last = t;
    }
    const dur = last - start;
    if (dur >= MIN_SESSION_MS) sessions.push({ uk, start, dur });
  }
  return sessions;
}

function buildSessionBuckets(durs: number[]): PetTowerSessionBucket[] {
  const ranges = [
    { range_label: '<1分钟', min: 0, max: 60_000 },
    { range_label: '1-5分钟', min: 60_000, max: 5 * 60_000 },
    { range_label: '5-15分钟', min: 5 * 60_000, max: 15 * 60_000 },
    { range_label: '15-30分钟', min: 15 * 60_000, max: 30 * 60_000 },
    { range_label: '30-60分钟', min: 30 * 60_000, max: 60 * 60_000 },
    { range_label: '60分钟+', min: 60 * 60_000, max: Number.POSITIVE_INFINITY },
  ];
  return ranges.map((r) => ({
    range_label: r.range_label,
    count: durs.filter((d) => d >= r.min && d < r.max).length,
  }));
}

function buildDaily(
  rows: AnalyticsRow[],
  sessions: SessionSpan[],
  gameKey: string,
): PetTowerDailyPoint[] {
  const map = new Map<string, {
    users: Set<string>;
    play_ms: number;
    session_cnt: number;
    ad_show_cnt: number;
    ad_revenue: number;
    tower_starts: number;
    tower_clears: number;
  }>();
  const ensure = (dateKey: string) => {
    let item = map.get(dateKey);
    if (!item) {
      item = {
        users: new Set(),
        play_ms: 0,
        session_cnt: 0,
        ad_show_cnt: 0,
        ad_revenue: 0,
        tower_starts: 0,
        tower_clears: 0,
      };
      map.set(dateKey, item);
    }
    return item;
  };
  for (const s of sessions) {
    const item = ensure(toLocalDateKey(s.start));
    item.users.add(s.uk);
    item.play_ms += s.dur;
    item.session_cnt += 1;
  }
  for (const row of rows) {
    const item = ensure(toLocalDateKey(row.event_ts));
    if (row.uk) item.users.add(row.uk);
    if (row.event_name === 'ad_show') {
      item.ad_show_cnt += 1;
      item.ad_revenue += getEstimatedEcpm(
        gameKey,
        strParam(row, 'ad_type', 'reward'),
        strParam(row, 'scene', 'unknown'),
      ) / 1000;
    }
    if (row.event_name === 'tower_floor_start') item.tower_starts += 1;
    if (row.event_name === 'tower_floor_clear') item.tower_clears += 1;
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date_key, item]) => ({
      date_key,
      dau: item.users.size,
      play_minutes: round1(item.play_ms / 60_000),
      minutes_per_user: item.users.size > 0 ? round1(item.play_ms / 60_000 / item.users.size) : 0,
      session_cnt: item.session_cnt,
      ad_show_cnt: item.ad_show_cnt,
      ad_revenue_estimated_cny: round2(item.ad_revenue),
      tower_starts: item.tower_starts,
      tower_clears: item.tower_clears,
    }));
}

function buildFloorBands(
  starts: AnalyticsRow[],
  clears: AnalyticsRow[],
): PetTowerFloorBand[] {
  const map = new Map<number, { starts: number; clears: number; coins: number[] }>();
  const touch = (floor: number) => {
    const band = Math.floor(Math.max(0, floor - 1) / MILESTONE_EVERY);
    let item = map.get(band);
    if (!item) {
      item = { starts: 0, clears: 0, coins: [] };
      map.set(band, item);
    }
    return { band, item };
  };
  for (const row of starts) touch(numParam(row, 'floor')).item.starts += 1;
  for (const row of clears) {
    const { item } = touch(numParam(row, 'floor'));
    item.clears += 1;
    const coins = numParam(row, 'tower_coins');
    if (coins > 0) item.coins.push(coins);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([band, item]) => {
      const band_from = band * MILESTONE_EVERY + 1;
      const band_to = band_from + MILESTONE_EVERY - 1;
      return {
        band_label: `${band_from}-${band_to}`,
        band_from,
        band_to,
        starts: item.starts,
        clears: item.clears,
        clear_rate: item.starts > 0 ? item.clears / item.starts : null,
        avg_coins: avg(item.coins),
        coins_sum: item.coins.reduce((sum, v) => sum + v, 0),
        difficulty_mid: towerDifficulty(Math.floor((band_from + band_to) / 2)),
      };
    });
}

function buildFloorRows(starts: AnalyticsRow[], clears: AnalyticsRow[]): PetTowerFloorRow[] {
  const map = new Map<number, { starts: number; clears: number; coins: number[] }>();
  for (const row of starts) {
    const floor = numParam(row, 'floor');
    if (floor <= 0) continue;
    const item = map.get(floor) || { starts: 0, clears: 0, coins: [] };
    item.starts += 1;
    map.set(floor, item);
  }
  for (const row of clears) {
    const floor = numParam(row, 'floor');
    if (floor <= 0) continue;
    const item = map.get(floor) || { starts: 0, clears: 0, coins: [] };
    item.clears += 1;
    const coins = numParam(row, 'tower_coins');
    if (coins > 0) item.coins.push(coins);
    map.set(floor, item);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([floor, item]) => {
      const clear_rate = item.starts > 0 ? item.clears / item.starts : null;
      return {
        floor,
        starts: item.starts,
        clears: item.clears,
        clear_rate,
        avg_coins: avg(item.coins),
        difficulty: towerDifficulty(floor),
        is_wall: item.starts >= 5 && clear_rate !== null && clear_rate < 0.4,
      };
    });
}

function pickGrindBand(bands: PetTowerFloorBand[]): PetTowerFloorBand | null {
  const withStarts = bands.filter((b) => b.starts > 0);
  if (withStarts.length === 0) return null;
  return withStarts.reduce((best, row) => (row.starts > best.starts ? row : best));
}

function buildBattleModes(rows: AnalyticsRow[]): PetTowerBattleMode[] {
  const map = new Map<string, { durs: number[]; turns: number[] }>();
  for (const row of rows.filter((r) => r.event_name === 'level_clear')) {
    const mode = battleModeOf(strParam(row, 'level_name', ''));
    const item = map.get(mode) || { durs: [], turns: [] };
    const dur = numParam(row, 'duration_ms');
    const turns = numParam(row, 'turns_used');
    if (dur > 0) item.durs.push(dur);
    if (turns > 0) item.turns.push(turns);
    map.set(mode, item);
  }
  const order = ['mainline', 'tower', 'realm', 'other'];
  return Array.from(map.entries())
    .map(([mode, item]) => ({
      mode,
      clears: item.durs.length,
      avg_duration_ms: avg(item.durs),
      avg_turns: avg(item.turns),
    }))
    .sort((a, b) => order.indexOf(a.mode) - order.indexOf(b.mode));
}

function buildAdScenes(
  shows: AnalyticsRow[],
  closes: AnalyticsRow[],
  gameKey: string,
): PetTowerAdScene[] {
  const map = new Map<string, { shows: number; completes: number; revenue: number }>();
  for (const row of shows) {
    const scene = strParam(row, 'scene', 'unknown');
    const item = map.get(scene) || { shows: 0, completes: 0, revenue: 0 };
    item.shows += 1;
    item.revenue += getEstimatedEcpm(gameKey, strParam(row, 'ad_type', 'reward'), scene) / 1000;
    map.set(scene, item);
  }
  for (const row of closes) {
    const scene = strParam(row, 'scene', 'unknown');
    const item = map.get(scene) || { shows: 0, completes: 0, revenue: 0 };
    if (boolParam(row, 'completed')) item.completes += 1;
    map.set(scene, item);
  }
  return Array.from(map.entries())
    .map(([scene, item]) => ({
      scene,
      shows: item.shows,
      completes: item.completes,
      complete_rate: item.shows > 0 ? item.completes / item.shows : null,
      revenue_estimated_cny: round2(item.revenue),
    }))
    .sort((a, b) => b.shows - a.shows);
}

function buildExchanges(rows: AnalyticsRow[]): PetTowerExchangeRow[] {
  const map = new Map<string, { count: number; cost_sum: number }>();
  for (const row of rows) {
    const optionId = strParam(row, 'option_id', 'unknown');
    const item = map.get(optionId) || { count: 0, cost_sum: 0 };
    item.count += 1;
    item.cost_sum += numParam(row, 'cost');
    map.set(optionId, item);
  }
  return Array.from(map.entries())
    .map(([option_id, item]) => ({ option_id, count: item.count, cost_sum: item.cost_sum }))
    .sort((a, b) => b.count - a.count);
}

function battleModeOf(levelName: string): string {
  if (levelName.startsWith('tower_')) return 'tower';
  if (levelName.startsWith('realm_') || levelName.startsWith('secret')) return 'realm';
  if (!levelName) return 'other';
  return 'mainline';
}

function towerDifficulty(floor: number): number {
  const base = DIFFICULTY_BASE * Math.pow(DIFFICULTY_GROWTH, Math.max(1, floor));
  const milestone = floor > 0 && floor % MILESTONE_EVERY === 0;
  return round2(milestone ? base * MILESTONE_DIFF_MULT : base);
}

function toLocalDateKey(ts: number): string {
  const d = new Date(Number(ts) || 0);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function paramsOf(row: AnalyticsRow): Record<string, unknown> {
  const raw = row.params_json;
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function strParam(row: AnalyticsRow, key: string, fallback: string): string {
  const value = paramsOf(row)[key];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function numParam(row: AnalyticsRow, key: string): number {
  const value = Number(paramsOf(row)[key]);
  return Number.isFinite(value) ? value : 0;
}

function boolParam(row: AnalyticsRow, key: string): boolean {
  const value = paramsOf(row)[key];
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }
  return false;
}

function maxNum(rows: AnalyticsRow[], key: string): number {
  let max = 0;
  for (const row of rows) max = Math.max(max, numParam(row, key));
  return max;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const mid = values.length >> 1;
  return values.length % 2 === 0
    ? Math.round(((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2)
    : (values[mid] ?? 0);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

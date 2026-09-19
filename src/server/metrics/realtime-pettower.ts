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
 *
 * DAU 口径与首页一致：只数 session_start。login / tutorial 有、但没发出 session_start 的
 * 人不当 DAU，否则 KPI 和逐日柱会对不上。
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
  device_brand: string;
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

export interface PetTowerFunnelStep {
  key: string;
  label: string;
  users: number;
  /** 相对漏斗第一步的留存比例 */
  rate_from_top: number | null;
  /** 相对上一步的流失比例，越大越是断点 */
  drop_from_prev: number | null;
  lost_from_prev: number;
}

export interface PetTowerEarlyLevelRow {
  level_name: string;
  start_users: number;
  clear_users: number;
  fail_users: number;
  clear_rate: number | null;
  retry_per_user: number;
  avg_turns_clear: number;
  avg_turns_fail: number;
  avg_duration_ms: number;
}

export interface PetTowerDwellBucket {
  range_label: string;
  users: number;
  share: number;
  /** 该时长档里进过首关 / 通过首关的人，用来区分「加载掉的」和「被难度劝退的」 */
  entered_first_level: number;
  cleared_first_level: number;
  first_clear_rate: number | null;
}

export interface PetTowerDeviceRow {
  brand: string;
  users: number;
  reached_battle: number;
  reach_rate: number | null;
  bounce_under_1min: number;
  bounce_rate: number | null;
}

export interface PetTowerErrorRow {
  err_msg: string;
  count: number;
  users: number;
}

export interface PetTowerColdStart {
  new_users: number;
  returning_users: number;
  bounce_under_1min: number;
  bounce_rate: number | null;
  reached_first_match: number;
  first_match_rate: number | null;
  first_level_clear_users: number;
  first_level_clear_rate: number | null;
  funnel: PetTowerFunnelStep[];
  dwell_buckets: PetTowerDwellBucket[];
  early_levels: PetTowerEarlyLevelRow[];
  devices: PetTowerDeviceRow[];
  errors: PetTowerErrorRow[];
}

/**
 * 冷启动漏斗顺序。tutorial_step 的 step_id 由 xiaochu2 端上报，
 * 这里只取「每个新用户是否到达过」，不管重复触发。
 */
const ONBOARDING_STEPS: Array<{ key: string; label: string }> = [
  { key: 'session_start', label: '进游戏' },
  { key: 'home_start_shown', label: '看到主页' },
  { key: 'home_welcome_continue', label: '过欢迎页' },
  { key: 'home_start_tapped', label: '点开始' },
  { key: 'coach_hint', label: '引导提示' },
  { key: 'battle_enter_first', label: '进首战' },
  { key: 'first_touch', label: '首次触屏' },
  { key: 'first_match', label: '首次消除' },
  { key: 'level_clear_first', label: '通过首关' },
];

const BOUNCE_MS = 60_000;

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
  cold_start: PetTowerColdStart;
}

export async function getPetTowerGameplayOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<PetTowerGameplayOverview> {
  const [rows, returningUsers] = await Promise.all([
    listRows(gameKey, fromTs, toTs, platform),
    listReturningUsers(gameKey, fromTs, platform),
  ]);
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
    cold_start: buildColdStart(rows, returningUsers),
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
    `SELECT event_name, event_ts, ${USER_KEY_SQL} AS uk, device_brand, params_json
       FROM analytics_events
      WHERE game_key = ?
        AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`,
    [gameKey, fromTs, toTs, ...platformParams],
  );
  return rows as AnalyticsRow[];
}

/**
 * 窗口内出现过的用户里，哪些在窗口开始前就来过。
 * 用于把「平台推的新量」和老玩家分开，否则漏斗会被老号的直接进战斗污染。
 */
async function listReturningUsers(
  gameKey: string,
  fromTs: number,
  platform?: string,
): Promise<Set<string>> {
  const platformParams = platformSqlParams(platform);
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT DISTINCT ${USER_KEY_SQL} AS uk
       FROM analytics_events
      WHERE game_key = ?
        AND event_ts < ?${PLATFORM_SQL}`,
    [gameKey, fromTs, ...platformParams],
  );
  return new Set((rows as Array<{ uk: string }>).map((row) => row.uk).filter(Boolean));
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
    playUsers: Set<string>;
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
        playUsers: new Set(),
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
    item.playUsers.add(s.uk);
    item.play_ms += s.dur;
    item.session_cnt += 1;
  }
  for (const row of rows) {
    const item = ensure(toLocalDateKey(row.event_ts));
    // 与窗口 KPI / 首页同一口径，不能把任意埋点都算进 DAU
    if (row.event_name === 'session_start' && row.uk) item.users.add(row.uk);
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
      minutes_per_user: item.playUsers.size > 0 ? round1(item.play_ms / 60_000 / item.playUsers.size) : 0,
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

/**
 * 冷启动视角：这波量到底走到哪一步就没了。
 * 只看新用户（窗口前没出现过），老玩家会跳过引导，混进来会把漏斗算虚。
 */
function buildColdStart(rows: AnalyticsRow[], returning: Set<string>): PetTowerColdStart {
  const allUsers = new Set<string>();
  for (const row of rows) if (row.uk) allUsers.add(row.uk);
  const newUsers = new Set([...allUsers].filter((uk) => !returning.has(uk)));
  const isNew = (uk: string) => newUsers.has(uk);

  // 每个漏斗节点到达过的新用户
  const reached = new Map<string, Set<string>>();
  const touch = (key: string, uk: string) => {
    if (!uk || !isNew(uk)) return;
    let set = reached.get(key);
    if (!set) {
      set = new Set();
      reached.set(key, set);
    }
    set.add(uk);
  };

  const firstLevelName = pickFirstLevelName(rows);
  const spanByUser = new Map<string, { min: number; max: number }>();
  const brandByUser = new Map<string, string>();

  for (const row of rows) {
    const uk = row.uk;
    if (!uk) continue;
    const ts = Number(row.event_ts) || 0;
    const span = spanByUser.get(uk);
    if (!span) spanByUser.set(uk, { min: ts, max: ts });
    else {
      if (ts < span.min) span.min = ts;
      if (ts > span.max) span.max = ts;
    }
    if (row.device_brand && !brandByUser.has(uk)) brandByUser.set(uk, row.device_brand);

    if (row.event_name === 'session_start') touch('session_start', uk);
    if (row.event_name === 'tutorial_step') touch(strParam(row, 'step_id', ''), uk);
    if (strParam(row, 'level_name', '') === firstLevelName) {
      if (row.event_name === 'level_clear') touch('level_clear_first', uk);
      if (row.event_name === 'level_start') touch('level_start_first', uk);
    }
  }

  // 基准用「新用户总数」而不是 session_start：端上偶发漏报会让后面的步骤反超首步
  const top = newUsers.size;
  const funnel: PetTowerFunnelStep[] = [{
    key: 'new_user',
    label: '新用户',
    users: top,
    rate_from_top: top > 0 ? 1 : null,
    drop_from_prev: null,
    lost_from_prev: 0,
  }];
  let prev = top;
  for (const step of ONBOARDING_STEPS) {
    const users = reached.get(step.key)?.size ?? 0;
    // 埋点倒挂时按 0 流失处理，不要显示负数
    const drop = prev > 0 ? Math.max(0, round4(1 - users / prev)) : null;
    funnel.push({
      key: step.key,
      label: step.label,
      users,
      rate_from_top: top > 0 ? round4(users / top) : null,
      drop_from_prev: drop,
      lost_from_prev: Math.max(0, prev - users),
    });
    prev = Math.max(users, 0);
  }

  const newSpans = [...newUsers]
    .map((uk) => (spanByUser.get(uk)?.max ?? 0) - (spanByUser.get(uk)?.min ?? 0))
    .filter((v) => v >= 0);
  const bounce = newSpans.filter((v) => v < BOUNCE_MS).length;

  const devices = buildDeviceRows(newUsers, brandByUser, spanByUser, reached.get('first_match'));

  return {
    new_users: newUsers.size,
    returning_users: allUsers.size - newUsers.size,
    bounce_under_1min: bounce,
    bounce_rate: newUsers.size > 0 ? round4(bounce / newUsers.size) : null,
    reached_first_match: reached.get('first_match')?.size ?? 0,
    first_match_rate: newUsers.size > 0
      ? round4((reached.get('first_match')?.size ?? 0) / newUsers.size)
      : null,
    first_level_clear_users: reached.get('level_clear_first')?.size ?? 0,
    first_level_clear_rate: newUsers.size > 0
      ? round4((reached.get('level_clear_first')?.size ?? 0) / newUsers.size)
      : null,
    funnel,
    dwell_buckets: buildDwellBuckets(
      newUsers,
      spanByUser,
      reached.get('level_start_first') ?? new Set(),
      reached.get('level_clear_first') ?? new Set(),
    ),
    early_levels: buildEarlyLevels(rows),
    devices,
    errors: buildErrorRows(rows),
  };
}

/** 主线首关名：取窗口内 level_start 最多的 stage_*，避免把秘境/塔当首关 */
function pickFirstLevelName(rows: AnalyticsRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.event_name !== 'level_start') continue;
    const name = strParam(row, 'level_name', '');
    if (!name.startsWith('stage_')) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [name, n] of counts) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  return best;
}

/**
 * 停留时长 × 首关结果。单看「多少人秒退」分不清是加载没进来还是打不过，
 * 这张交叉表能直接回答：愿意留下来的人，首关到底过不过得去。
 */
function buildDwellBuckets(
  users: Set<string>,
  spanByUser: Map<string, { min: number; max: number }>,
  enteredFirst: Set<string>,
  clearedFirst: Set<string>,
): PetTowerDwellBucket[] {
  const ranges = [
    { range_label: '<30秒', min: 0, max: 30_000 },
    { range_label: '30秒-1分', min: 30_000, max: 60_000 },
    { range_label: '1-3分钟', min: 60_000, max: 180_000 },
    { range_label: '3-10分钟', min: 180_000, max: 600_000 },
    { range_label: '10-30分钟', min: 600_000, max: 1_800_000 },
    { range_label: '30分钟+', min: 1_800_000, max: Number.POSITIVE_INFINITY },
  ];
  const acc = ranges.map(() => ({ users: 0, entered: 0, cleared: 0 }));
  for (const uk of users) {
    const span = spanByUser.get(uk);
    const ms = span ? span.max - span.min : 0;
    const idx = ranges.findIndex((r) => ms >= r.min && ms < r.max);
    if (idx < 0) continue;
    const item = acc[idx]!;
    item.users += 1;
    if (enteredFirst.has(uk)) item.entered += 1;
    if (clearedFirst.has(uk)) item.cleared += 1;
  }
  const total = users.size;
  return ranges.map((r, i) => {
    const item = acc[i]!;
    return {
      range_label: r.range_label,
      users: item.users,
      share: total > 0 ? round4(item.users / total) : 0,
      entered_first_level: item.entered,
      cleared_first_level: item.cleared,
      first_clear_rate: item.entered > 0 ? round4(item.cleared / item.entered) : null,
    };
  });
}

/** 前几关按人去重的通关率。重试次数高说明是难度问题，不是看不懂 */
function buildEarlyLevels(rows: AnalyticsRow[]): PetTowerEarlyLevelRow[] {
  interface Acc {
    startUsers: Set<string>;
    clearUsers: Set<string>;
    failUsers: Set<string>;
    startCnt: number;
    clearTurns: number[];
    failTurns: number[];
    durations: number[];
  }
  const map = new Map<string, Acc>();
  const ensure = (name: string): Acc => {
    let item = map.get(name);
    if (!item) {
      item = {
        startUsers: new Set(),
        clearUsers: new Set(),
        failUsers: new Set(),
        startCnt: 0,
        clearTurns: [],
        failTurns: [],
        durations: [],
      };
      map.set(name, item);
    }
    return item;
  };
  for (const row of rows) {
    const name = strParam(row, 'level_name', '');
    if (!name.startsWith('stage_') || name.includes('_elite')) continue;
    const item = ensure(name);
    if (row.event_name === 'level_start') {
      item.startCnt += 1;
      if (row.uk) item.startUsers.add(row.uk);
    } else if (row.event_name === 'level_clear') {
      if (row.uk) item.clearUsers.add(row.uk);
      const turns = numParam(row, 'turns_used');
      if (turns > 0) item.clearTurns.push(turns);
      const dur = numParam(row, 'duration_ms');
      if (dur > 0) item.durations.push(dur);
    } else if (row.event_name === 'level_fail') {
      if (row.uk) item.failUsers.add(row.uk);
      const turns = numParam(row, 'turns_used');
      if (turns > 0) item.failTurns.push(turns);
    }
  }
  return Array.from(map.entries())
    .map(([level_name, item]) => ({
      level_name,
      start_users: item.startUsers.size,
      clear_users: item.clearUsers.size,
      fail_users: item.failUsers.size,
      clear_rate: item.startUsers.size > 0 ? round4(item.clearUsers.size / item.startUsers.size) : null,
      retry_per_user: item.startUsers.size > 0 ? round2(item.startCnt / item.startUsers.size) : 0,
      avg_turns_clear: avg(item.clearTurns),
      avg_turns_fail: avg(item.failTurns),
      avg_duration_ms: avg(item.durations),
    }))
    .sort((a, b) => b.start_users - a.start_users)
    .slice(0, 12);
}

function buildDeviceRows(
  newUsers: Set<string>,
  brandByUser: Map<string, string>,
  spanByUser: Map<string, { min: number; max: number }>,
  battleUsers: Set<string> | undefined,
): PetTowerDeviceRow[] {
  const map = new Map<string, { users: number; reached: number; bounce: number }>();
  for (const uk of newUsers) {
    const brand = brandByUser.get(uk) || 'unknown';
    const item = map.get(brand) || { users: 0, reached: 0, bounce: 0 };
    item.users += 1;
    if (battleUsers?.has(uk)) item.reached += 1;
    const span = spanByUser.get(uk);
    if (span && span.max - span.min < BOUNCE_MS) item.bounce += 1;
    map.set(brand, item);
  }
  return Array.from(map.entries())
    .map(([brand, item]) => ({
      brand,
      users: item.users,
      reached_battle: item.reached,
      reach_rate: item.users > 0 ? round4(item.reached / item.users) : null,
      bounce_under_1min: item.bounce,
      bounce_rate: item.users > 0 ? round4(item.bounce / item.users) : null,
    }))
    .sort((a, b) => b.users - a.users)
    .slice(0, 12);
}

function buildErrorRows(rows: AnalyticsRow[]): PetTowerErrorRow[] {
  const map = new Map<string, { count: number; users: Set<string> }>();
  for (const row of rows) {
    if (row.event_name !== 'app_error') continue;
    const msg = strParam(row, 'err_msg', 'unknown').slice(0, 160);
    const item = map.get(msg) || { count: 0, users: new Set<string>() };
    item.count += 1;
    if (row.uk) item.users.add(row.uk);
    map.set(msg, item);
  }
  return Array.from(map.entries())
    .map(([err_msg, item]) => ({ err_msg, count: item.count, users: item.users.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
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

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

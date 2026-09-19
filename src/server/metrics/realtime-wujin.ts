/**
 * 无尽纹章（wujin_wenzhang）专属玩法聚合。
 *
 * 端上没有 tutorial_step：新手漏斗用 session_start + 首局 / 教学章通关 / 下一章 / 无尽。
 * 时长走全游戏标准口径 session-duration.ts，和大盘「人均时长」同一套。
 */
import { getEstimatedEcpm } from '../config/ecpm';
import { getMysqlPool } from '../db';
import { PLATFORM_SQL, platformSqlParams } from './platform-filter';
import {
  buildSessionBuckets,
  reconstructSessions,
  summarizeSessions,
  type SessionBucket,
  type SessionSpan,
} from './session-duration';

export const WUJIN_GAME_KEY = 'wujin_wenzhang';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
const BOUNCE_MS = 60_000;
const TUTORIAL_DUNGEON = 'dungeon_grassland';
const ENDLESS_DUNGEON = 'dungeon_endless';

interface AnalyticsRow {
  event_name: string;
  event_ts: number;
  uk: string;
  device_brand: string;
  params_json: unknown;
}

export interface WujinDailyPoint {
  date_key: string;
  dau: number;
  play_minutes: number;
  minutes_per_user: number;
  session_cnt: number;
  run_starts: number;
  run_clears: number;
  ad_show_cnt: number;
  ad_revenue_estimated_cny: number;
}

export interface WujinAdScene {
  scene: string;
  shows: number;
  completes: number;
  complete_rate: number | null;
  revenue_estimated_cny: number;
}

export interface WujinFunnelStep {
  key: string;
  label: string;
  users: number;
  rate_from_top: number | null;
  drop_from_prev: number | null;
  lost_from_prev: number;
}

export interface WujinDwellBucket {
  range_label: string;
  users: number;
  share: number;
  entered_run: number;
  cleared_tutorial: number;
  tutorial_clear_rate: number | null;
}

export interface WujinDeviceRow {
  brand: string;
  users: number;
  reached_run: number;
  reach_rate: number | null;
  bounce_under_1min: number;
  bounce_rate: number | null;
}

export interface WujinErrorRow {
  err_msg: string;
  count: number;
  users: number;
}

export interface WujinDungeonRow {
  dungeon_id: string;
  kind: 'chapter' | 'elite' | 'endless' | 'other';
  start_cnt: number;
  start_users: number;
  clear_cnt: number;
  clear_users: number;
  fail_cnt: number;
  abandon_cnt: number;
  clear_rate: number | null;
  avg_duration_ms: number;
  avg_wave: number;
  max_wave: number;
}

export interface WujinColdStart {
  new_users: number;
  returning_users: number;
  bounce_under_1min: number;
  bounce_rate: number | null;
  first_run_users: number;
  first_run_rate: number | null;
  tutorial_clear_users: number;
  tutorial_clear_rate: number | null;
  next_chapter_users: number;
  next_chapter_rate: number | null;
  endless_users: number;
  endless_rate: number | null;
  funnel: WujinFunnelStep[];
  dwell_buckets: WujinDwellBucket[];
  devices: WujinDeviceRow[];
  errors: WujinErrorRow[];
}

const ONBOARDING_STEPS: Array<{ key: string; label: string }> = [
  { key: 'session_start', label: '进游戏' },
  { key: 'first_run', label: '进首局' },
  { key: 'grassland_start', label: '进教学章' },
  { key: 'grassland_clear', label: '通关教学章' },
  { key: 'next_chapter', label: '进下一章' },
  { key: 'endless', label: '进无尽' },
];

export interface WujinGameplayOverview {
  kpi: {
    dau: number;
    play_users: number;
    session_cnt: number;
    play_minutes: number;
    avg_session_ms: number;
    median_session_ms: number;
    minutes_per_user: number;
    duration_source: 'reconstructed_idle_gap';
    run_start_cnt: number;
    run_clear_cnt: number;
    run_fail_cnt: number;
    run_clear_rate: number | null;
    run_users: number;
    avg_run_ms: number;
    endless_start_cnt: number;
    endless_users: number;
    max_endless_wave: number;
    ad_show_cnt: number;
    ad_complete_cnt: number;
    ad_revenue_estimated_cny: number;
    arpdau_estimated_cny: number;
    computed_at: number;
  };
  session_buckets: SessionBucket[];
  daily: WujinDailyPoint[];
  dungeons: WujinDungeonRow[];
  ad_scenes: WujinAdScene[];
  cold_start: WujinColdStart;
}

export async function getWujinGameplayOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<WujinGameplayOverview> {
  const [rows, returningUsers] = await Promise.all([
    listRows(gameKey, fromTs, toTs, platform),
    listReturningUsers(gameKey, fromTs, platform),
  ]);
  const sessions = reconstructSessions(rows.map((r) => ({ uk: r.uk, event_ts: r.event_ts })));
  const duration = summarizeSessions(sessions);
  const dau = new Set(
    rows.filter((r) => r.event_name === 'session_start' && r.uk).map((r) => r.uk),
  ).size || duration.play_users;

  const adShows = rows.filter((r) => r.event_name === 'ad_show');
  const adCloses = rows.filter((r) => r.event_name === 'ad_close');
  const adRevenue = adShows.reduce((sum, row) => {
    return sum + getEstimatedEcpm(gameKey, strParam(row, 'ad_type', 'reward'), strParam(row, 'scene', 'unknown')) / 1000;
  }, 0);

  const starts = rows.filter((r) => r.event_name === 'level_start' && !isSandbox(strParam(r, 'level_name', '')));
  const clears = rows.filter((r) => r.event_name === 'level_clear' && !isSandbox(strParam(r, 'level_name', '')));
  const fails = rows.filter((r) => r.event_name === 'level_fail' && !isSandbox(strParam(r, 'level_name', '')));
  const runDurs = [...clears, ...fails].map((r) => numParam(r, 'duration_ms')).filter(saneDuration);
  const endlessStarts = starts.filter((r) => dungeonKind(strParam(r, 'level_name', '')) === 'endless');
  const endlessWaves = [...starts, ...clears, ...fails]
    .filter((r) => dungeonKind(strParam(r, 'level_name', '')) === 'endless')
    .map((r) => numParam(r, 'reached_wave'));

  return {
    kpi: {
      dau,
      ...duration,
      run_start_cnt: starts.length,
      run_clear_cnt: clears.length,
      run_fail_cnt: fails.length,
      run_clear_rate: starts.length > 0 ? clears.length / starts.length : null,
      run_users: new Set(starts.map((r) => r.uk).filter(Boolean)).size,
      avg_run_ms: avg(runDurs),
      endless_start_cnt: endlessStarts.length,
      endless_users: new Set(endlessStarts.map((r) => r.uk).filter(Boolean)).size,
      max_endless_wave: endlessWaves.length > 0 ? Math.max(...endlessWaves) : 0,
      ad_show_cnt: adShows.length,
      ad_complete_cnt: adCloses.filter((row) => boolParam(row, 'completed') || boolParam(row, 'is_ended')).length,
      ad_revenue_estimated_cny: round2(adRevenue),
      arpdau_estimated_cny: dau > 0 ? round2(adRevenue / dau) : 0,
      computed_at: Date.now(),
    },
    session_buckets: buildSessionBuckets(sessions.map((s) => s.dur)),
    daily: buildDaily(rows, sessions, gameKey),
    dungeons: buildDungeons(starts, clears, fails),
    ad_scenes: buildAdScenes(adShows, adCloses, gameKey),
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

function buildDaily(rows: AnalyticsRow[], sessions: SessionSpan[], gameKey: string): WujinDailyPoint[] {
  const map = new Map<string, {
    users: Set<string>;
    playUsers: Set<string>;
    play_ms: number;
    session_cnt: number;
    run_starts: number;
    run_clears: number;
    ad_show_cnt: number;
    ad_revenue: number;
  }>();
  const ensure = (dateKey: string) => {
    let item = map.get(dateKey);
    if (!item) {
      item = {
        users: new Set(),
        playUsers: new Set(),
        play_ms: 0,
        session_cnt: 0,
        run_starts: 0,
        run_clears: 0,
        ad_show_cnt: 0,
        ad_revenue: 0,
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
    if (row.event_name === 'session_start' && row.uk) item.users.add(row.uk);
    if (row.event_name === 'level_start' && !isSandbox(strParam(row, 'level_name', ''))) item.run_starts += 1;
    if (row.event_name === 'level_clear' && !isSandbox(strParam(row, 'level_name', ''))) item.run_clears += 1;
    if (row.event_name === 'ad_show') {
      item.ad_show_cnt += 1;
      item.ad_revenue += getEstimatedEcpm(
        gameKey,
        strParam(row, 'ad_type', 'reward'),
        strParam(row, 'scene', 'unknown'),
      ) / 1000;
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date_key, item]) => ({
      date_key,
      dau: item.users.size,
      play_minutes: round1(item.play_ms / 60_000),
      minutes_per_user: item.playUsers.size > 0 ? round1(item.play_ms / 60_000 / item.playUsers.size) : 0,
      session_cnt: item.session_cnt,
      run_starts: item.run_starts,
      run_clears: item.run_clears,
      ad_show_cnt: item.ad_show_cnt,
      ad_revenue_estimated_cny: round2(item.ad_revenue),
    }));
}

function buildDungeons(
  starts: AnalyticsRow[],
  clears: AnalyticsRow[],
  fails: AnalyticsRow[],
): WujinDungeonRow[] {
  const map = new Map<string, {
    startUsers: Set<string>;
    clearUsers: Set<string>;
    start_cnt: number;
    clear_cnt: number;
    fail_cnt: number;
    abandon_cnt: number;
    durs: number[];
    waves: number[];
  }>();
  const ensure = (id: string) => {
    let item = map.get(id);
    if (!item) {
      item = {
        startUsers: new Set(),
        clearUsers: new Set(),
        start_cnt: 0,
        clear_cnt: 0,
        fail_cnt: 0,
        abandon_cnt: 0,
        durs: [],
        waves: [],
      };
      map.set(id, item);
    }
    return item;
  };
  for (const row of starts) {
    const id = strParam(row, 'level_name', 'unknown');
    const item = ensure(id);
    item.start_cnt += 1;
    if (row.uk) item.startUsers.add(row.uk);
  }
  for (const row of clears) {
    const item = ensure(strParam(row, 'level_name', 'unknown'));
    item.clear_cnt += 1;
    if (row.uk) item.clearUsers.add(row.uk);
    const dur = numParam(row, 'duration_ms');
    if (saneDuration(dur)) item.durs.push(dur);
    const wave = numParam(row, 'reached_wave');
    if (wave > 0) item.waves.push(wave);
  }
  for (const row of fails) {
    const item = ensure(strParam(row, 'level_name', 'unknown'));
    if (strParam(row, 'reason', '') === 'abandon') item.abandon_cnt += 1;
    else item.fail_cnt += 1;
    const dur = numParam(row, 'duration_ms');
    if (saneDuration(dur)) item.durs.push(dur);
    const wave = numParam(row, 'reached_wave');
    if (wave > 0) item.waves.push(wave);
  }
  return Array.from(map.entries())
    .map(([dungeon_id, item]) => ({
      dungeon_id,
      kind: dungeonKind(dungeon_id),
      start_cnt: item.start_cnt,
      start_users: item.startUsers.size,
      clear_cnt: item.clear_cnt,
      clear_users: item.clearUsers.size,
      fail_cnt: item.fail_cnt,
      abandon_cnt: item.abandon_cnt,
      clear_rate: item.start_cnt > 0 ? item.clear_cnt / item.start_cnt : null,
      avg_duration_ms: avg(item.durs),
      avg_wave: avg(item.waves),
      max_wave: item.waves.length > 0 ? Math.max(...item.waves) : 0,
    }))
    .sort((a, b) => b.start_cnt - a.start_cnt);
}

function buildAdScenes(
  shows: AnalyticsRow[],
  closes: AnalyticsRow[],
  gameKey: string,
): WujinAdScene[] {
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
    if (boolParam(row, 'completed') || boolParam(row, 'is_ended')) item.completes += 1;
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

function buildColdStart(rows: AnalyticsRow[], returning: Set<string>): WujinColdStart {
  const allUsers = new Set<string>();
  for (const row of rows) if (row.uk) allUsers.add(row.uk);
  const newUsers = new Set([...allUsers].filter((uk) => !returning.has(uk)));
  const isNew = (uk: string) => newUsers.has(uk);

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
    if (row.event_name === 'level_start') {
      const name = strParam(row, 'level_name', '');
      if (isSandbox(name)) continue;
      touch('first_run', uk);
      if (name === TUTORIAL_DUNGEON) touch('grassland_start', uk);
      if (dungeonKind(name) === 'chapter' && name !== TUTORIAL_DUNGEON) touch('next_chapter', uk);
      if (dungeonKind(name) === 'endless') touch('endless', uk);
    }
    if (row.event_name === 'level_clear' && strParam(row, 'level_name', '') === TUTORIAL_DUNGEON) {
      touch('grassland_clear', uk);
    }
  }

  const top = newUsers.size;
  const newSpans = [...newUsers]
    .map((uk) => (spanByUser.get(uk)?.max ?? 0) - (spanByUser.get(uk)?.min ?? 0))
    .filter((v) => v >= 0);
  const bounce = newSpans.filter((v) => v < BOUNCE_MS).length;

  return {
    new_users: newUsers.size,
    returning_users: allUsers.size - newUsers.size,
    bounce_under_1min: bounce,
    bounce_rate: newUsers.size > 0 ? round4(bounce / newUsers.size) : null,
    first_run_users: reached.get('first_run')?.size ?? 0,
    first_run_rate: newUsers.size > 0 ? round4((reached.get('first_run')?.size ?? 0) / newUsers.size) : null,
    tutorial_clear_users: reached.get('grassland_clear')?.size ?? 0,
    tutorial_clear_rate: newUsers.size > 0
      ? round4((reached.get('grassland_clear')?.size ?? 0) / newUsers.size)
      : null,
    next_chapter_users: reached.get('next_chapter')?.size ?? 0,
    next_chapter_rate: newUsers.size > 0
      ? round4((reached.get('next_chapter')?.size ?? 0) / newUsers.size)
      : null,
    endless_users: reached.get('endless')?.size ?? 0,
    endless_rate: newUsers.size > 0 ? round4((reached.get('endless')?.size ?? 0) / newUsers.size) : null,
    funnel: buildFunnel(top, ONBOARDING_STEPS, reached),
    dwell_buckets: buildDwellBuckets(
      newUsers,
      spanByUser,
      reached.get('first_run') ?? new Set(),
      reached.get('grassland_clear') ?? new Set(),
    ),
    devices: buildDeviceRows(newUsers, brandByUser, spanByUser, reached.get('first_run')),
    errors: buildErrorRows(rows),
  };
}

function buildFunnel(
  top: number,
  steps: Array<{ key: string; label: string }>,
  reached: Map<string, Set<string>>,
): WujinFunnelStep[] {
  const funnel: WujinFunnelStep[] = [{
    key: 'new_user',
    label: '新用户',
    users: top,
    rate_from_top: top > 0 ? 1 : null,
    drop_from_prev: null,
    lost_from_prev: 0,
  }];
  let prev = top;
  for (const step of steps) {
    const users = reached.get(step.key)?.size ?? 0;
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
  return funnel;
}

function buildDwellBuckets(
  users: Set<string>,
  spanByUser: Map<string, { min: number; max: number }>,
  enteredRun: Set<string>,
  clearedTutorial: Set<string>,
): WujinDwellBucket[] {
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
    if (enteredRun.has(uk)) item.entered += 1;
    if (clearedTutorial.has(uk)) item.cleared += 1;
  }
  const total = users.size;
  return ranges.map((r, i) => {
    const item = acc[i]!;
    return {
      range_label: r.range_label,
      users: item.users,
      share: total > 0 ? round4(item.users / total) : 0,
      entered_run: item.entered,
      cleared_tutorial: item.cleared,
      tutorial_clear_rate: item.users > 0 ? round4(item.cleared / item.users) : null,
    };
  });
}

function buildDeviceRows(
  newUsers: Set<string>,
  brandByUser: Map<string, string>,
  spanByUser: Map<string, { min: number; max: number }>,
  runUsers: Set<string> | undefined,
): WujinDeviceRow[] {
  const map = new Map<string, { users: number; reached: number; bounce: number }>();
  for (const uk of newUsers) {
    const brand = brandByUser.get(uk) || 'unknown';
    const item = map.get(brand) || { users: 0, reached: 0, bounce: 0 };
    item.users += 1;
    if (runUsers?.has(uk)) item.reached += 1;
    const span = spanByUser.get(uk);
    if (span && span.max - span.min < BOUNCE_MS) item.bounce += 1;
    map.set(brand, item);
  }
  return Array.from(map.entries())
    .map(([brand, item]) => ({
      brand,
      users: item.users,
      reached_run: item.reached,
      reach_rate: item.users > 0 ? round4(item.reached / item.users) : null,
      bounce_under_1min: item.bounce,
      bounce_rate: item.users > 0 ? round4(item.bounce / item.users) : null,
    }))
    .sort((a, b) => b.users - a.users)
    .slice(0, 12);
}

function buildErrorRows(rows: AnalyticsRow[]): WujinErrorRow[] {
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

function dungeonKind(id: string): WujinDungeonRow['kind'] {
  if (id === ENDLESS_DUNGEON || id.startsWith('dungeon_endless')) return 'endless';
  if (id.startsWith('elite_')) return 'elite';
  if (id.startsWith('dungeon_')) return 'chapter';
  return 'other';
}

function isSandbox(id: string): boolean {
  return id === 'dungeon_vfx_lab' || id.includes('sandbox');
}

/** 端上 runStartedAt 偶尔跨天没重置，会出几十亿毫秒的脏时长 */
function saneDuration(ms: number): boolean {
  return ms >= 5_000 && ms <= 3 * 60 * 60 * 1000;
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

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
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

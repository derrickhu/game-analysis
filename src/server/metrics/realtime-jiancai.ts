/**
 * 扫荡菜场（jiancai）专属玩法聚合。
 *
 * 隔离约定：
 * - 只读 game_key = jiancai 的事件，路由层再锁一次
 * - 不改 petTower / huahua / hotpot / caizhu 的 SQL 或面板
 *
 * 引导埋点是「离开某步」时打：有 intro = 看完开场，卡在开场里的人不会进这一格。
 * 时长与塔 2 同一口径：相邻事件间隔 ≤5 分钟拼会话，≥15 秒才计数。
 * DAU 只数 session_start，和首页、逐日柱对齐。
 */
import { getEstimatedEcpm } from '../config/ecpm';
import { getMysqlPool } from '../db';
import { PLATFORM_SQL, platformSqlParams } from './platform-filter';

export const JIANCAI_GAME_KEY = 'jiancai';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
const IDLE_GAP_MS = 5 * 60_000;
const MIN_SESSION_MS = 15_000;
const BOUNCE_MS = 60_000;

interface AnalyticsRow {
  event_name: string;
  event_ts: number;
  uk: string;
  device_brand: string;
  params_json: unknown;
}

export interface JiancaiSessionBucket {
  range_label: string;
  count: number;
}

export interface JiancaiDailyPoint {
  date_key: string;
  dau: number;
  play_minutes: number;
  minutes_per_user: number;
  session_cnt: number;
  ad_show_cnt: number;
  ad_revenue_estimated_cny: number;
  outing_starts: number;
  outing_completes: number;
  tutorial_done_users: number;
}

export interface JiancaiAdScene {
  scene: string;
  shows: number;
  completes: number;
  complete_rate: number | null;
  revenue_estimated_cny: number;
}

export interface JiancaiFunnelStep {
  key: string;
  label: string;
  users: number;
  rate_from_top: number | null;
  drop_from_prev: number | null;
  lost_from_prev: number;
}

export interface JiancaiDwellBucket {
  range_label: string;
  users: number;
  share: number;
  took_loot: number;
  tutorial_done: number;
  tutorial_done_rate: number | null;
}

export interface JiancaiDeviceRow {
  brand: string;
  users: number;
  reached_loot: number;
  reach_rate: number | null;
  bounce_under_1min: number;
  bounce_rate: number | null;
}

export interface JiancaiErrorRow {
  err_msg: string;
  count: number;
  users: number;
}

export interface JiancaiMarketRow {
  market_id: string;
  start_cnt: number;
  start_users: number;
  complete_cnt: number;
  complete_users: number;
  abandon_cnt: number;
  complete_rate: number | null;
  avg_duration_ms: number;
  avg_item_count: number;
  safe_cnt: number;
  messy_cnt: number;
}

export interface JiancaiColdStart {
  new_users: number;
  returning_users: number;
  bounce_under_1min: number;
  bounce_rate: number | null;
  took_loot_users: number;
  took_loot_rate: number | null;
  tutorial_done_users: number;
  tutorial_done_rate: number | null;
  first_outing_users: number;
  first_outing_rate: number | null;
  first_extract_users: number;
  first_extract_rate: number | null;
  funnel: JiancaiFunnelStep[];
  tutorial_steps: JiancaiFunnelStep[];
  dwell_buckets: JiancaiDwellBucket[];
  devices: JiancaiDeviceRow[];
  errors: JiancaiErrorRow[];
}

/** 看板漏斗：只留能判断「会不会玩」的里程碑，21 步全量放表格 */
const ONBOARDING_STEPS: Array<{ key: string; label: string }> = [
  { key: 'session_start', label: '进游戏' },
  { key: 'intro', label: '过开场' },
  { key: 'go_out', label: '出门' },
  { key: 'pick_xiangko', label: '选巷口' },
  { key: 'take_loot', label: '捡到第一份菜' },
  { key: 'close_basket', label: '关菜篮' },
  { key: 'free_walk', label: '自由逛摊' },
  { key: 'wait_result', label: '回家看收成' },
  { key: 'cook_dish', label: '炒第一道菜' },
  { key: 'sell_dish', label: '卖掉' },
  { key: 'claim_gift', label: '领礼金' },
  { key: 'completed', label: '引导完成' },
];

/** 与 jiancai-rosa TUTORIAL_SEQUENCE 对齐，不含旧流程 go_home */
const TUTORIAL_DETAIL_STEPS: Array<{ key: string; label: string }> = [
  { key: 'intro', label: '过开场' },
  { key: 'go_out', label: '出门' },
  { key: 'pick_xiangko', label: '选巷口' },
  { key: 'click_card', label: '翻摊卡' },
  { key: 'click_pile', label: '抽菜' },
  { key: 'take_loot', label: '捡进篮' },
  { key: 'open_basket', label: '打开菜篮' },
  { key: 'basket_dry', label: '看干区' },
  { key: 'basket_wet', label: '看湿区' },
  { key: 'close_basket', label: '关菜篮' },
  { key: 'return_map', label: '回地图' },
  { key: 'free_walk', label: '自由逛摊' },
  { key: 'wait_result', label: '看收成' },
  { key: 'cook_table', label: '走到灶台' },
  { key: 'cook_dish', label: '炒菜苔' },
  { key: 'open_fridge', label: '开冰箱' },
  { key: 'inspect_dish', label: '点开菜' },
  { key: 'sell_dish', label: '卖掉' },
  { key: 'claim_gift', label: '领礼金' },
  { key: 'hint_door', label: '再出门提示' },
  { key: 'completed', label: '引导完成' },
];

export interface JiancaiGameplayOverview {
  kpi: {
    dau: number;
    play_users: number;
    session_cnt: number;
    play_minutes: number;
    avg_session_ms: number;
    median_session_ms: number;
    minutes_per_user: number;
    duration_source: 'reconstructed_idle_gap';
    outing_start_cnt: number;
    outing_complete_cnt: number;
    outing_abandon_cnt: number;
    outing_complete_rate: number | null;
    outing_users: number;
    avg_outing_ms: number;
    ad_show_cnt: number;
    ad_complete_cnt: number;
    ad_revenue_estimated_cny: number;
    arpdau_estimated_cny: number;
    computed_at: number;
  };
  session_buckets: JiancaiSessionBucket[];
  daily: JiancaiDailyPoint[];
  markets: JiancaiMarketRow[];
  ad_scenes: JiancaiAdScene[];
  cold_start: JiancaiColdStart;
}

export async function getJiancaiGameplayOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<JiancaiGameplayOverview> {
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
  const adComplete = adCloses.filter((row) => isAdComplete(row)).length;

  const outingStarts = rows.filter((r) => r.event_name === 'quest_start');
  const outingCompletes = rows.filter((r) => r.event_name === 'quest_complete');
  const outingAbandons = rows.filter((r) => r.event_name === 'quest_abandon');
  const outingUsers = new Set(outingStarts.map((r) => r.uk).filter(Boolean));
  const outingDurs = outingCompletes.map((r) => numParam(r, 'duration_ms')).filter((n) => n > 0);

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
      outing_start_cnt: outingStarts.length,
      outing_complete_cnt: outingCompletes.length,
      outing_abandon_cnt: outingAbandons.length,
      outing_complete_rate: outingStarts.length > 0
        ? outingCompletes.length / outingStarts.length
        : null,
      outing_users: outingUsers.size,
      avg_outing_ms: avg(outingDurs),
      ad_show_cnt: adShows.length,
      ad_complete_cnt: adComplete,
      ad_revenue_estimated_cny: round2(adRevenue),
      arpdau_estimated_cny: dau > 0 ? round2(adRevenue / dau) : 0,
      computed_at: Date.now(),
    },
    session_buckets: buildSessionBuckets(durs),
    daily: buildDaily(rows, sessions, gameKey),
    markets: buildMarkets(outingStarts, outingCompletes, outingAbandons),
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

function buildSessionBuckets(durs: number[]): JiancaiSessionBucket[] {
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
): JiancaiDailyPoint[] {
  const map = new Map<string, {
    users: Set<string>;
    playUsers: Set<string>;
    play_ms: number;
    session_cnt: number;
    ad_show_cnt: number;
    ad_revenue: number;
    outing_starts: number;
    outing_completes: number;
    tutorialDone: Set<string>;
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
        outing_starts: 0,
        outing_completes: 0,
        tutorialDone: new Set(),
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
    if (row.event_name === 'ad_show') {
      item.ad_show_cnt += 1;
      item.ad_revenue += getEstimatedEcpm(
        gameKey,
        strParam(row, 'ad_type', 'reward'),
        strParam(row, 'scene', 'unknown'),
      ) / 1000;
    }
    if (row.event_name === 'quest_start') item.outing_starts += 1;
    if (row.event_name === 'quest_complete') item.outing_completes += 1;
    if (row.event_name === 'tutorial_step' && strParam(row, 'step_id', '') === 'completed' && row.uk) {
      item.tutorialDone.add(row.uk);
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
      ad_show_cnt: item.ad_show_cnt,
      ad_revenue_estimated_cny: round2(item.ad_revenue),
      outing_starts: item.outing_starts,
      outing_completes: item.outing_completes,
      tutorial_done_users: item.tutorialDone.size,
    }));
}

function buildMarkets(
  starts: AnalyticsRow[],
  completes: AnalyticsRow[],
  abandons: AnalyticsRow[],
): JiancaiMarketRow[] {
  const map = new Map<string, {
    startUsers: Set<string>;
    completeUsers: Set<string>;
    start_cnt: number;
    complete_cnt: number;
    abandon_cnt: number;
    durs: number[];
    items: number[];
    safe_cnt: number;
    messy_cnt: number;
  }>();
  const ensure = (id: string) => {
    let item = map.get(id);
    if (!item) {
      item = {
        startUsers: new Set(),
        completeUsers: new Set(),
        start_cnt: 0,
        complete_cnt: 0,
        abandon_cnt: 0,
        durs: [],
        items: [],
        safe_cnt: 0,
        messy_cnt: 0,
      };
      map.set(id, item);
    }
    return item;
  };
  for (const row of starts) {
    const item = ensure(strParam(row, 'market_id', 'unknown'));
    item.start_cnt += 1;
    if (row.uk) item.startUsers.add(row.uk);
  }
  for (const row of completes) {
    const item = ensure(strParam(row, 'market_id', 'unknown'));
    item.complete_cnt += 1;
    if (row.uk) item.completeUsers.add(row.uk);
    const dur = numParam(row, 'duration_ms');
    if (dur > 0) item.durs.push(dur);
    const count = numParam(row, 'item_count');
    if (count > 0) item.items.push(count);
    const kind = strParam(row, 'extract_kind', '');
    if (kind === 'safe') item.safe_cnt += 1;
    if (kind === 'messy') item.messy_cnt += 1;
  }
  for (const row of abandons) {
    ensure(strParam(row, 'market_id', 'unknown')).abandon_cnt += 1;
  }
  return Array.from(map.entries())
    .map(([market_id, item]) => ({
      market_id,
      start_cnt: item.start_cnt,
      start_users: item.startUsers.size,
      complete_cnt: item.complete_cnt,
      complete_users: item.completeUsers.size,
      abandon_cnt: item.abandon_cnt,
      complete_rate: item.start_cnt > 0 ? item.complete_cnt / item.start_cnt : null,
      avg_duration_ms: avg(item.durs),
      avg_item_count: avg(item.items),
      safe_cnt: item.safe_cnt,
      messy_cnt: item.messy_cnt,
    }))
    .sort((a, b) => b.start_cnt - a.start_cnt);
}

function buildAdScenes(
  shows: AnalyticsRow[],
  closes: AnalyticsRow[],
  gameKey: string,
): JiancaiAdScene[] {
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
    if (isAdComplete(row)) item.completes += 1;
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

function buildColdStart(rows: AnalyticsRow[], returning: Set<string>): JiancaiColdStart {
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
    if (row.event_name === 'tutorial_step') touch(strParam(row, 'step_id', ''), uk);
    if (row.event_name === 'quest_start') touch('quest_start', uk);
    if (row.event_name === 'quest_complete') touch('quest_complete', uk);
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
    took_loot_users: reached.get('take_loot')?.size ?? 0,
    took_loot_rate: newUsers.size > 0
      ? round4((reached.get('take_loot')?.size ?? 0) / newUsers.size)
      : null,
    tutorial_done_users: reached.get('completed')?.size ?? 0,
    tutorial_done_rate: newUsers.size > 0
      ? round4((reached.get('completed')?.size ?? 0) / newUsers.size)
      : null,
    first_outing_users: reached.get('quest_start')?.size ?? 0,
    first_outing_rate: newUsers.size > 0
      ? round4((reached.get('quest_start')?.size ?? 0) / newUsers.size)
      : null,
    first_extract_users: reached.get('quest_complete')?.size ?? 0,
    first_extract_rate: newUsers.size > 0
      ? round4((reached.get('quest_complete')?.size ?? 0) / newUsers.size)
      : null,
    funnel: buildFunnel(top, ONBOARDING_STEPS, reached),
    tutorial_steps: buildFunnel(top, TUTORIAL_DETAIL_STEPS, reached),
    dwell_buckets: buildDwellBuckets(
      newUsers,
      spanByUser,
      reached.get('take_loot') ?? new Set(),
      reached.get('completed') ?? new Set(),
    ),
    devices: buildDeviceRows(newUsers, brandByUser, spanByUser, reached.get('take_loot')),
    errors: buildErrorRows(rows),
  };
}

function buildFunnel(
  top: number,
  steps: Array<{ key: string; label: string }>,
  reached: Map<string, Set<string>>,
): JiancaiFunnelStep[] {
  const funnel: JiancaiFunnelStep[] = [{
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
  tookLoot: Set<string>,
  tutorialDone: Set<string>,
): JiancaiDwellBucket[] {
  const ranges = [
    { range_label: '<30秒', min: 0, max: 30_000 },
    { range_label: '30秒-1分', min: 30_000, max: 60_000 },
    { range_label: '1-3分钟', min: 60_000, max: 180_000 },
    { range_label: '3-10分钟', min: 180_000, max: 600_000 },
    { range_label: '10-30分钟', min: 600_000, max: 1_800_000 },
    { range_label: '30分钟+', min: 1_800_000, max: Number.POSITIVE_INFINITY },
  ];
  const acc = ranges.map(() => ({ users: 0, loot: 0, done: 0 }));
  for (const uk of users) {
    const span = spanByUser.get(uk);
    const ms = span ? span.max - span.min : 0;
    const idx = ranges.findIndex((r) => ms >= r.min && ms < r.max);
    if (idx < 0) continue;
    const item = acc[idx]!;
    item.users += 1;
    if (tookLoot.has(uk)) item.loot += 1;
    if (tutorialDone.has(uk)) item.done += 1;
  }
  const total = users.size;
  return ranges.map((r, i) => {
    const item = acc[i]!;
    return {
      range_label: r.range_label,
      users: item.users,
      share: total > 0 ? round4(item.users / total) : 0,
      took_loot: item.loot,
      tutorial_done: item.done,
      tutorial_done_rate: item.users > 0 ? round4(item.done / item.users) : null,
    };
  });
}

function buildDeviceRows(
  newUsers: Set<string>,
  brandByUser: Map<string, string>,
  spanByUser: Map<string, { min: number; max: number }>,
  lootUsers: Set<string> | undefined,
): JiancaiDeviceRow[] {
  const map = new Map<string, { users: number; reached: number; bounce: number }>();
  for (const uk of newUsers) {
    const brand = brandByUser.get(uk) || 'unknown';
    const item = map.get(brand) || { users: 0, reached: 0, bounce: 0 };
    item.users += 1;
    if (lootUsers?.has(uk)) item.reached += 1;
    const span = spanByUser.get(uk);
    if (span && span.max - span.min < BOUNCE_MS) item.bounce += 1;
    map.set(brand, item);
  }
  return Array.from(map.entries())
    .map(([brand, item]) => ({
      brand,
      users: item.users,
      reached_loot: item.reached,
      reach_rate: item.users > 0 ? round4(item.reached / item.users) : null,
      bounce_under_1min: item.bounce,
      bounce_rate: item.users > 0 ? round4(item.bounce / item.users) : null,
    }))
    .sort((a, b) => b.users - a.users)
    .slice(0, 12);
}

function buildErrorRows(rows: AnalyticsRow[]): JiancaiErrorRow[] {
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

function isAdComplete(row: AnalyticsRow): boolean {
  return boolParam(row, 'is_ended') || boolParam(row, 'completed');
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

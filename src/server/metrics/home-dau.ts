import { CHANNEL_PLATFORMS, PLATFORM_LABEL, type PlatformFilter } from '../../shared/platforms';
import { getEnabledAnalyticsGames } from '../config/analytics-games';
import { getDb, getMysqlPool, isMysqlMode } from '../db';
import {
  ensureLtvTables,
  listBusinessDailyRevenue,
  listBusinessMonthlyRevenue,
  rebuildBusinessMonthlyRevenue,
  sumBusinessDailyRevenueByGame,
} from '../ltv-db';
import { IDLE_GAP_MS } from './session-duration';

/**
 * 经分主页：一次查出「今日」各游戏 × 各渠道的 DAU 与广告曝光。
 * - DAU 口径与 overview 一致：session_start + COALESCE(NULLIF(user_id,''), anonymous_id)
 * - 曝光口径与商业化看板一致：ad_show 事件次数（非去重用户）
 */

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
const SESSION_START = 'session_start';
const AD_SHOW = 'ad_show';
const HOME_PLATFORMS = CHANNEL_PLATFORMS;

export type HomePlatform = PlatformFilter;

export interface HomePlatformDau {
  platform: HomePlatform;
  label: string;
  dau: number;
  ad_show_cnt: number;
  /** 该平台昨天（T-1）流量主真实收入，元；Tap / 华为暂无官方接口，固定 0 */
  t1_revenue_cny: number;
}

export interface HomeGameDau {
  game_key: string;
  display_name: string;
  total_dau: number;
  total_ad_show: number;
  /** 当月截至昨天（T-1）微信+抖音流量主真实收入，元 */
  month_t1_revenue_cny: number;
  platforms: HomePlatformDau[];
}

export interface HomeMonthlyGameSeries {
  game_key: string;
  display_name: string;
  revenue: number[];
}

export interface HomeChannelTrend {
  games: HomeMonthlyGameSeries[];
  total: number[];
}

export interface HomeMonthlyTrend {
  months: string[];
  games: HomeMonthlyGameSeries[];
  total: number[];
  wechat: HomeChannelTrend;
  douyin: HomeChannelTrend;
}

export interface HomeDailyTrend {
  days: string[];
  games: HomeMonthlyGameSeries[];
  total: number[];
  wechat: HomeChannelTrend;
  douyin: HomeChannelTrend;
}

export interface HomeActivitySeries {
  game_key: string;
  display_name: string;
  values: number[];
}

export interface HomeActivityTrend {
  games: HomeActivitySeries[];
  total: number[];
}

/** 全部游戏的日活 / 曝光曲线。日活按渠道相加，和卡片上的总日活同一口径。 */
export interface HomeActivityWindow {
  buckets: string[];
  dau: HomeActivityTrend;
  ad_show: HomeActivityTrend;
}

/**
 * 近 24 小时在线曲线。每个点是该时刻往前 5 分钟内有过任意事件的人数，
 * 和在线时长用的空闲间隔同一口径。同一人在两个游戏里各算 1。
 */
export interface HomeOnlineWindow {
  buckets: string[];
  games: HomeActivitySeries[];
  total: number[];
}

export interface HomeDauResult {
  date_key: string;
  from_ts: number;
  to_ts: number;
  computed_at: number;
  /** 当月 1 号 */
  month_from_date: string;
  /** 昨天（T-1）；若今天是 1 号则仍为昨天，但不计入当月 */
  month_t1_date: string;
  /** 近一月日曲线起点（含），截止 T-1 */
  daily_from_date: string;
  /** 全部游戏当月 T-1 收益合计（微信+抖音） */
  month_t1_revenue_cny: number;
  month_t1_wechat_revenue_cny: number;
  month_t1_douyin_revenue_cny: number;
  daily_trend: HomeDailyTrend;
  monthly_trend: HomeMonthlyTrend;
  /** 全部游戏今日日活，等于各游戏卡片总日活之和 */
  today_total_dau: number;
  /** 全部游戏今日广告曝光次数 */
  today_total_ad_show: number;
  /** 活跃曲线起点（含今天） */
  activity_daily_from_date: string;
  activity_daily: HomeActivityWindow;
  activity_monthly: HomeActivityWindow;
  /** 此刻在线：最近 5 分钟有操作的人数，各游戏相加 */
  online_now: number;
  /** 近 24 小时每 5 分钟一个点，最后一个点就是 online_now */
  online_today: HomeOnlineWindow;
  games: HomeGameDau[];
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatLocalDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfLocalMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function listMonthKeys(now: number, count = 12): string[] {
  const cursor = new Date(now);
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${d.getMonth() + 1 < 10 ? `0${d.getMonth() + 1}` : `${d.getMonth() + 1}`}`);
  }
  return keys;
}

function addLocalDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** 近一月日曲线：含 T-1 共 30 天。 */
const DAILY_TREND_DAYS = 30;

function listDayKeys(fromTs: number, toTs: number): string[] {
  const keys: string[] = [];
  let cursor = startOfLocalDay(fromTs);
  const end = startOfLocalDay(toTs);
  while (cursor <= end) {
    keys.push(formatLocalDate(cursor));
    cursor = addLocalDays(cursor, 1);
  }
  return keys;
}

interface RawDauRow {
  game_key: string;
  platform: string;
  dau: number;
}

interface RawAdShowRow {
  game_key: string;
  platform: string;
  ad_show_cnt: number;
}

type SqlParam = string | number;

async function queryGroupedRows<T extends Record<string, unknown>>(
  sql: string,
  params: SqlParam[],
  mapRow: (row: Record<string, unknown>) => T,
): Promise<T[]> {
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(sql, params);
    return (rows as Array<Record<string, unknown>>).map(mapRow);
  }
  const rows = getDb().prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapRow);
}

async function queryTodayDauRows(fromTs: number, toTs: number, gameKeys: string[]): Promise<RawDauRow[]> {
  if (gameKeys.length === 0 || toTs < fromTs) return [];

  const placeholders = gameKeys.map(() => '?').join(', ');
  const platformPlaceholders = HOME_PLATFORMS.map(() => '?').join(', ');
  const sql = `
    SELECT game_key,
           platform,
           COUNT(DISTINCT ${USER_KEY_SQL}) AS dau
      FROM analytics_events
     WHERE event_name = ?
       AND event_ts BETWEEN ? AND ?
       AND game_key IN (${placeholders})
       AND platform IN (${platformPlaceholders})
     GROUP BY game_key, platform`;
  const params = [SESSION_START, fromTs, toTs, ...gameKeys, ...HOME_PLATFORMS];

  return queryGroupedRows(sql, params, (r) => ({
    game_key: String(r.game_key),
    platform: String(r.platform || ''),
    dau: Number(r.dau || 0),
  }));
}

async function queryTodayAdShowRows(fromTs: number, toTs: number, gameKeys: string[]): Promise<RawAdShowRow[]> {
  if (gameKeys.length === 0 || toTs < fromTs) return [];

  const placeholders = gameKeys.map(() => '?').join(', ');
  const platformPlaceholders = HOME_PLATFORMS.map(() => '?').join(', ');
  const sql = `
    SELECT game_key,
           platform,
           COUNT(*) AS ad_show_cnt
      FROM analytics_events
     WHERE event_name = ?
       AND event_ts BETWEEN ? AND ?
       AND game_key IN (${placeholders})
       AND platform IN (${platformPlaceholders})
     GROUP BY game_key, platform`;
  const params = [AD_SHOW, fromTs, toTs, ...gameKeys, ...HOME_PLATFORMS];

  return queryGroupedRows(sql, params, (r) => ({
    game_key: String(r.game_key),
    platform: String(r.platform || ''),
    ad_show_cnt: Number(r.ad_show_cnt || 0),
  }));
}

interface RawActivityRow {
  game_key: string;
  bucket: string;
  dau: number;
  ad_show_cnt: number;
}

function activityPlaceholders(gameKeys: string[]): { gameSql: string; platformSql: string; params: SqlParam[] } {
  return {
    gameSql: gameKeys.map(() => '?').join(', '),
    platformSql: HOME_PLATFORMS.map(() => '?').join(', '),
    params: [...gameKeys, ...HOME_PLATFORMS],
  };
}

/** 用户日表里的日活和曝光。今天的点稍后用实时事件覆盖，避免等 15 分钟回算。 */
async function queryActivityByDay(gameKeys: string[], fromDate: string, toDate: string): Promise<RawActivityRow[]> {
  if (!isMysqlMode() || gameKeys.length === 0 || toDate < fromDate) return [];
  try {
    await ensureLtvTables();
    const { gameSql, platformSql, params } = activityPlaceholders(gameKeys);
    const sql = `
      SELECT game_key,
             date_key AS bucket,
             SUM(CASE WHEN session_cnt > 0 THEN 1 ELSE 0 END) AS dau,
             SUM(ad_show_cnt) AS ad_show_cnt
        FROM analytics_user_daily
       WHERE date_key BETWEEN ? AND ?
         AND game_key IN (${gameSql})
         AND platform IN (${platformSql})
       GROUP BY game_key, date_key`;
    return queryGroupedRows(sql, [fromDate, toDate, ...params], (row) => ({
      game_key: String(row.game_key),
      bucket: String(row.bucket),
      dau: Number(row.dau || 0),
      ad_show_cnt: Number(row.ad_show_cnt || 0),
    }));
  } catch (error) {
    console.warn('[home-dau] 读取日活曝光日曲线失败:', error);
    return [];
  }
}

/** 月内去重日活。同一人玩了两个渠道算 2，和卡片「各渠道日活相加」一致。 */
async function queryActivityByMonth(gameKeys: string[], fromDate: string, toDate: string): Promise<RawActivityRow[]> {
  if (!isMysqlMode() || gameKeys.length === 0 || toDate < fromDate) return [];
  try {
    await ensureLtvTables();
    const { gameSql, platformSql, params } = activityPlaceholders(gameKeys);
    const sql = `
      SELECT game_key,
             SUBSTRING(date_key, 1, 7) AS bucket,
             COUNT(DISTINCT CONCAT(platform, '#', user_key)) AS dau,
             0 AS ad_show_cnt
        FROM analytics_user_daily
       WHERE session_cnt > 0
         AND date_key BETWEEN ? AND ?
         AND game_key IN (${gameSql})
         AND platform IN (${platformSql})
       GROUP BY game_key, SUBSTRING(date_key, 1, 7)`;
    return queryGroupedRows(sql, [fromDate, toDate, ...params], (row) => ({
      game_key: String(row.game_key),
      bucket: String(row.bucket),
      dau: Number(row.dau || 0),
      ad_show_cnt: 0,
    }));
  } catch (error) {
    console.warn('[home-dau] 读取月活曲线失败:', error);
    return [];
  }
}

function indexActivityRows(rows: RawActivityRow[]): Map<string, Map<string, RawActivityRow>> {
  const byGame = new Map<string, Map<string, RawActivityRow>>();
  for (const row of rows) {
    let byBucket = byGame.get(row.game_key);
    if (!byBucket) {
      byBucket = new Map();
      byGame.set(row.game_key, byBucket);
    }
    byBucket.set(row.bucket, row);
  }
  return byGame;
}

function buildActivityTrend(
  buckets: string[],
  games: HomeGameDau[],
  pick: (gameKey: string, bucket: string) => number,
): HomeActivityTrend {
  const series = games.map((game) => ({
    game_key: game.game_key,
    display_name: game.display_name,
    values: buckets.map((bucket) => pick(game.game_key, bucket)),
  }));
  return {
    games: series,
    total: buckets.map((_, index) => series.reduce((sum, game) => sum + (game.values[index] || 0), 0)),
  };
}

/** 在线判定窗口，和会话空闲间隔相同：超过 5 分钟没有事件算出线。 */
const ONLINE_BUCKET_MS = IDLE_GAP_MS;

interface RawOnlineBucket {
  game_key: string;
  bucket_end: number;
  online: number;
}

interface RawOnlineNow {
  game_key: string;
  online: number;
}

interface OnlineSample {
  /** 采样时刻。闭合桶是 5 分钟整点，最后一个未闭合桶是当前时间 */
  endTs: number;
  /** true 时用「此刻往前 5 分钟」的实时人数，保证曲线末端和大数字一致 */
  live: boolean;
}

const ONLINE_CURVE_MS = 24 * 60 * 60 * 1000;

function formatClockLabel(ts: number): string {
  const d = new Date(ts);
  const minute = d.getMinutes();
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${minute < 10 ? `0${minute}` : minute}`;
}

/** 窗口内每个 5 分钟整点一个样本；当前还没走到整点时，末尾再补「现在」。 */
export function listOnlineSamples(windowStart: number, now: number): OnlineSample[] {
  const samples: OnlineSample[] = [];
  const firstEnd = Math.floor(windowStart / ONLINE_BUCKET_MS) * ONLINE_BUCKET_MS + ONLINE_BUCKET_MS;
  const lastClosedEnd = Math.floor(now / ONLINE_BUCKET_MS) * ONLINE_BUCKET_MS;
  for (let end = firstEnd; end <= lastClosedEnd && end <= now; end += ONLINE_BUCKET_MS) {
    samples.push({ endTs: end, live: end === now });
  }
  if (now > lastClosedEnd || samples.length === 0) samples.push({ endTs: now, live: true });
  if (samples.length >= 2) {
    const last = samples[samples.length - 1];
    const prev = samples[samples.length - 2];
    if (last && prev && formatClockLabel(last.endTs) === formatClockLabel(prev.endTs)) {
      samples.splice(samples.length - 2, 1);
    }
  }
  return samples;
}

function onlineBucketEndSql(): string {
  const shift = ONLINE_BUCKET_MS - 1;
  if (isMysqlMode()) {
    return `((event_ts + ${shift}) DIV ${ONLINE_BUCKET_MS}) * ${ONLINE_BUCKET_MS}`;
  }
  return `(((event_ts + ${shift}) / ${ONLINE_BUCKET_MS}) * ${ONLINE_BUCKET_MS})`;
}

let onlineCurveCache: { key: string; at: number; rows: RawOnlineBucket[] } | null = null;

/** 已闭合 5 分钟窗的在线人数。同一个 5 分钟内曲线不变，结果按窗口缓存。 */
async function queryOnlineBuckets(fromTs: number, toTs: number, gameKeys: string[]): Promise<RawOnlineBucket[]> {
  if (gameKeys.length === 0 || toTs <= fromTs) return [];
  const cacheKey = `${Math.floor(fromTs / ONLINE_BUCKET_MS)}:${Math.floor(toTs / ONLINE_BUCKET_MS)}:${gameKeys.join(',')}`;
  if (onlineCurveCache && onlineCurveCache.key === cacheKey) {
    return onlineCurveCache.rows;
  }
  try {
    const { gameSql, platformSql, params } = activityPlaceholders(gameKeys);
    const bucketEnd = onlineBucketEndSql();
    const sql = `
      SELECT game_key,
             ${bucketEnd} AS bucket_end,
             COUNT(DISTINCT CONCAT(platform, '#', ${USER_KEY_SQL})) AS online
        FROM analytics_events
       WHERE event_ts > ? AND event_ts <= ?
         AND game_key IN (${gameSql})
         AND platform IN (${platformSql})
       GROUP BY game_key, ${bucketEnd}`;
    const rows = await queryGroupedRows(sql, [fromTs, toTs, ...params], (row) => ({
      game_key: String(row.game_key),
      bucket_end: Number(row.bucket_end || 0),
      online: Number(row.online || 0),
    }));
    onlineCurveCache = { key: cacheKey, at: Date.now(), rows };
    return rows;
  } catch (error) {
    console.warn('[home-dau] 读取今日在线曲线失败:', error);
    return [];
  }
}

async function queryOnlineNow(now: number, gameKeys: string[]): Promise<RawOnlineNow[]> {
  if (gameKeys.length === 0) return [];
  try {
    const { gameSql, platformSql, params } = activityPlaceholders(gameKeys);
    const sql = `
      SELECT game_key,
             COUNT(DISTINCT CONCAT(platform, '#', ${USER_KEY_SQL})) AS online
        FROM analytics_events
       WHERE event_ts > ? AND event_ts <= ?
         AND game_key IN (${gameSql})
         AND platform IN (${platformSql})
       GROUP BY game_key`;
    return queryGroupedRows(sql, [now - ONLINE_BUCKET_MS, now, ...params], (row) => ({
      game_key: String(row.game_key),
      online: Number(row.online || 0),
    }));
  } catch (error) {
    console.warn('[home-dau] 读取当前在线失败:', error);
    return [];
  }
}

function buildOnlineWindow(
  samples: OnlineSample[],
  games: HomeGameDau[],
  byBucket: Map<string, Map<number, number>>,
  liveByGame: Map<string, number>,
): HomeOnlineWindow {
  const series = games.map((game) => ({
    game_key: game.game_key,
    display_name: game.display_name,
    values: samples.map((sample) =>
      sample.live
        ? liveByGame.get(game.game_key) || 0
        : byBucket.get(game.game_key)?.get(sample.endTs) || 0,
    ),
  }));
  return {
    buckets: samples.map((sample) => formatClockLabel(sample.endTs)),
    games: series,
    total: samples.map((_, index) => series.reduce((sum, game) => sum + (game.values[index] || 0), 0)),
  };
}

/** 组装主页矩阵：游戏按 total_dau 降序；平台固定微信→抖音→Tap→华为。 */
export async function getHomeDau(now = Date.now()): Promise<HomeDauResult> {
  const fromTs = startOfLocalDay(now);
  const toTs = now;
  const monthFromTs = startOfLocalMonth(now);
  const t1Ts = fromTs - 1;
  const monthFromDate = formatLocalDate(monthFromTs);
  const monthT1Date = formatLocalDate(t1Ts);
  const enabled = getEnabledAnalyticsGames();
  const gameKeys = enabled.map((g) => g.gameKey);
  const monthKeys = listMonthKeys(now, 12);
  const fromMonth = monthKeys[0] || monthFromDate.slice(0, 7);
  const toMonth = monthKeys[monthKeys.length - 1] || monthFromDate.slice(0, 7);
  const dailyFromTs = addLocalDays(startOfLocalDay(t1Ts), -(DAILY_TREND_DAYS - 1));
  const dailyFromDate = formatLocalDate(dailyFromTs);
  const dayKeys = listDayKeys(dailyFromTs, t1Ts);
  const todayKey = formatLocalDate(fromTs);
  const activityFromDate = `${fromMonth}-01`;
  const activityDailyFromTs = addLocalDays(fromTs, -(DAILY_TREND_DAYS - 1));
  const activityDayKeys = listDayKeys(activityDailyFromTs, fromTs);
  const onlineSamples = listOnlineSamples(now - ONLINE_CURVE_MS, now);
  const onlineQueryFrom = Math.max(0, (onlineSamples[0]?.endTs || now) - ONLINE_BUCKET_MS);
  const [dauRows, adShowRows, revenueMap, monthlyRowsRaw, dailyRows, activityDailyRows, activityMonthRows, onlineRows, onlineNowRows] =
    await Promise.all([
      queryTodayDauRows(fromTs, toTs, gameKeys),
      queryTodayAdShowRows(fromTs, toTs, gameKeys),
      sumBusinessDailyRevenueByGame(gameKeys, monthFromDate, monthT1Date),
      listBusinessMonthlyRevenue(gameKeys, fromMonth, toMonth),
      listBusinessDailyRevenue(gameKeys, dailyFromDate, monthT1Date),
      queryActivityByDay(gameKeys, activityFromDate, todayKey),
      queryActivityByMonth(gameKeys, activityFromDate, todayKey),
      queryOnlineBuckets(onlineQueryFrom, toTs, gameKeys),
      queryOnlineNow(toTs, gameKeys),
    ]);
  let monthlyRows = monthlyRowsRaw;
  const monthlySplitMissing = monthlyRows.some(
    (row) => row.revenue_cny > 0 && row.wechat_revenue_cny === 0 && row.douyin_revenue_cny === 0,
  );
  if (gameKeys.length > 0 && (monthlyRows.length === 0 || monthlySplitMissing)) {
    await rebuildBusinessMonthlyRevenue({
      gameKeys,
      fromDate: `${fromMonth}-01`,
      toDate: monthT1Date,
    });
    monthlyRows = await listBusinessMonthlyRevenue(gameKeys, fromMonth, toMonth);
  }

  const dauMap = new Map<string, number>();
  for (const row of dauRows) {
    if (!(HOME_PLATFORMS as readonly string[]).includes(row.platform)) continue;
    dauMap.set(`${row.game_key}\0${row.platform}`, row.dau);
  }
  const adShowMap = new Map<string, number>();
  for (const row of adShowRows) {
    if (!(HOME_PLATFORMS as readonly string[]).includes(row.platform)) continue;
    adShowMap.set(`${row.game_key}\0${row.platform}`, row.ad_show_cnt);
  }
  const t1RevenueByGame = new Map<string, { wechat_cny: number; douyin_cny: number }>();
  for (const row of dailyRows) {
    if (row.date_key !== monthT1Date) continue;
    t1RevenueByGame.set(row.game_key, {
      wechat_cny: row.wechat_cny,
      douyin_cny: row.douyin_cny,
    });
  }

  const games: HomeGameDau[] = enabled.map((g) => {
    const t1Channel = t1RevenueByGame.get(g.gameKey);
    const platforms: HomePlatformDau[] = HOME_PLATFORMS.map((platform) => ({
      platform,
      label: PLATFORM_LABEL[platform],
      dau: dauMap.get(`${g.gameKey}\0${platform}`) || 0,
      ad_show_cnt: adShowMap.get(`${g.gameKey}\0${platform}`) || 0,
      t1_revenue_cny:
        platform === 'wechat'
          ? t1Channel?.wechat_cny || 0
          : platform === 'douyin'
            ? t1Channel?.douyin_cny || 0
            : 0,
    }));
    const total_dau = platforms.reduce((sum, p) => sum + p.dau, 0);
    const total_ad_show = platforms.reduce((sum, p) => sum + p.ad_show_cnt, 0);
    const channel = revenueMap.get(g.gameKey);
    const month_t1_revenue_cny = channel?.total_cny || 0;
    return {
      game_key: g.gameKey,
      display_name: g.displayName,
      total_dau,
      total_ad_show,
      month_t1_revenue_cny,
      platforms,
    };
  });

  games.sort((a, b) => b.total_dau - a.total_dau || a.display_name.localeCompare(b.display_name, 'zh-CN'));
  const month_t1_wechat_revenue_cny =
    Math.round(games.reduce((sum, g) => sum + (revenueMap.get(g.game_key)?.wechat_cny || 0), 0) * 100) / 100;
  const month_t1_douyin_revenue_cny =
    Math.round(games.reduce((sum, g) => sum + (revenueMap.get(g.game_key)?.douyin_cny || 0), 0) * 100) / 100;
  const month_t1_revenue_cny =
    Math.round((month_t1_wechat_revenue_cny + month_t1_douyin_revenue_cny) * 100) / 100;

  const currentMonthKey = monthFromDate.slice(0, 7);
  const monthlyByGame = new Map<string, Map<string, { total: number; wechat: number; douyin: number }>>();
  for (const row of monthlyRows) {
    let byMonth = monthlyByGame.get(row.game_key);
    if (!byMonth) {
      byMonth = new Map();
      monthlyByGame.set(row.game_key, byMonth);
    }
    byMonth.set(row.month_key, {
      total: row.revenue_cny,
      wechat: row.wechat_revenue_cny,
      douyin: row.douyin_revenue_cny,
    });
  }
  const monthlyTrend = buildChannelTrends(
    monthKeys,
    games,
    (gameKey, bucket) => {
      if (bucket === currentMonthKey) {
        const channel = revenueMap.get(gameKey);
        return {
          total: channel?.total_cny || 0,
          wechat: channel?.wechat_cny || 0,
          douyin: channel?.douyin_cny || 0,
        };
      }
      return monthlyByGame.get(gameKey)?.get(bucket) || { total: 0, wechat: 0, douyin: 0 };
    },
  );

  const dailyByGame = new Map<string, Map<string, { total: number; wechat: number; douyin: number }>>();
  for (const row of dailyRows) {
    let byDay = dailyByGame.get(row.game_key);
    if (!byDay) {
      byDay = new Map();
      dailyByGame.set(row.game_key, byDay);
    }
    byDay.set(row.date_key, {
      total: row.revenue_cny,
      wechat: row.wechat_cny,
      douyin: row.douyin_cny,
    });
  }
  const dailyTrend = buildChannelTrends(
    dayKeys,
    games,
    (gameKey, bucket) => dailyByGame.get(gameKey)?.get(bucket) || { total: 0, wechat: 0, douyin: 0 },
  );

  const activityByDay = indexActivityRows(activityDailyRows);
  const activityDauByMonth = indexActivityRows(activityMonthRows);
  const liveByGame = new Map(games.map((game) => [game.game_key, game]));
  const pickDailyActivity = (metric: 'dau' | 'ad') => (gameKey: string, bucket: string) => {
    if (bucket === todayKey) {
      const live = liveByGame.get(gameKey);
      return metric === 'dau' ? live?.total_dau || 0 : live?.total_ad_show || 0;
    }
    const point = activityByDay.get(gameKey)?.get(bucket);
    return metric === 'dau' ? point?.dau || 0 : point?.ad_show_cnt || 0;
  };
  const pickMonthAds = (gameKey: string, bucket: string) => {
    let total = 0;
    const byDay = activityByDay.get(gameKey);
    if (byDay) {
      for (const [day, point] of byDay) {
        if (day.slice(0, 7) !== bucket || day === todayKey) continue;
        total += point.ad_show_cnt;
      }
    }
    if (todayKey.slice(0, 7) === bucket) total += liveByGame.get(gameKey)?.total_ad_show || 0;
    return total;
  };
  const activityDaily: HomeActivityWindow = {
    buckets: activityDayKeys,
    dau: buildActivityTrend(activityDayKeys, games, pickDailyActivity('dau')),
    ad_show: buildActivityTrend(activityDayKeys, games, pickDailyActivity('ad')),
  };
  const activityMonthly: HomeActivityWindow = {
    buckets: monthKeys,
    dau: buildActivityTrend(
      monthKeys,
      games,
      (gameKey, bucket) => activityDauByMonth.get(gameKey)?.get(bucket)?.dau || 0,
    ),
    ad_show: buildActivityTrend(monthKeys, games, pickMonthAds),
  };
  const today_total_dau = games.reduce((sum, game) => sum + game.total_dau, 0);
  const today_total_ad_show = games.reduce((sum, game) => sum + game.total_ad_show, 0);
  const onlineByBucket = new Map<string, Map<number, number>>();
  for (const row of onlineRows) {
    let byEnd = onlineByBucket.get(row.game_key);
    if (!byEnd) {
      byEnd = new Map();
      onlineByBucket.set(row.game_key, byEnd);
    }
    byEnd.set(row.bucket_end, row.online);
  }
  const liveOnlineByGame = new Map(onlineNowRows.map((row) => [row.game_key, row.online]));
  const onlineToday = buildOnlineWindow(onlineSamples, games, onlineByBucket, liveOnlineByGame);
  const online_now = games.reduce((sum, game) => sum + (liveOnlineByGame.get(game.game_key) || 0), 0);

  return {
    date_key: formatLocalDate(fromTs),
    from_ts: fromTs,
    to_ts: toTs,
    computed_at: now,
    month_from_date: monthFromDate,
    month_t1_date: monthT1Date,
    daily_from_date: dailyFromDate,
    month_t1_revenue_cny,
    month_t1_wechat_revenue_cny,
    month_t1_douyin_revenue_cny,
    daily_trend: { days: dayKeys, ...dailyTrend },
    monthly_trend: { months: monthKeys, ...monthlyTrend },
    today_total_dau,
    today_total_ad_show,
    activity_daily_from_date: activityDayKeys[0] || todayKey,
    activity_daily: activityDaily,
    activity_monthly: activityMonthly,
    online_now,
    online_today: onlineToday,
    games,
  };
}

function buildChannelTrends(
  buckets: string[],
  games: HomeGameDau[],
  pick: (gameKey: string, bucket: string) => { total: number; wechat: number; douyin: number },
): {
  games: HomeMonthlyGameSeries[];
  total: number[];
  wechat: HomeChannelTrend;
  douyin: HomeChannelTrend;
} {
  const totalGames: HomeMonthlyGameSeries[] = [];
  const wechatGames: HomeMonthlyGameSeries[] = [];
  const douyinGames: HomeMonthlyGameSeries[] = [];
  for (const game of games) {
    const total: number[] = [];
    const wechat: number[] = [];
    const douyin: number[] = [];
    for (const bucket of buckets) {
      const value = pick(game.game_key, bucket);
      total.push(value.total);
      wechat.push(value.wechat);
      douyin.push(value.douyin);
    }
    totalGames.push({ game_key: game.game_key, display_name: game.display_name, revenue: total });
    wechatGames.push({ game_key: game.game_key, display_name: game.display_name, revenue: wechat });
    douyinGames.push({ game_key: game.game_key, display_name: game.display_name, revenue: douyin });
  }
  const sumAt = (series: HomeMonthlyGameSeries[], idx: number) =>
    Math.round(series.reduce((sum, game) => sum + (game.revenue[idx] || 0), 0) * 100) / 100;
  return {
    games: totalGames,
    total: buckets.map((_, idx) => sumAt(totalGames, idx)),
    wechat: {
      games: wechatGames,
      total: buckets.map((_, idx) => sumAt(wechatGames, idx)),
    },
    douyin: {
      games: douyinGames,
      total: buckets.map((_, idx) => sumAt(douyinGames, idx)),
    },
  };
}

import { getEnabledAnalyticsGames } from '../config/analytics-games';
import { getDb, getMysqlPool, isMysqlMode } from '../db';
import {
  listBusinessMonthlyRevenue,
  rebuildBusinessMonthlyRevenue,
  sumBusinessDailyRevenueByGame,
} from '../ltv-db';

/**
 * 经分主页：一次查出「今日」各游戏 × 微信/抖音的 DAU 与广告曝光。
 * - DAU 口径与 overview 一致：session_start + COALESCE(NULLIF(user_id,''), anonymous_id)
 * - 曝光口径与商业化看板一致：ad_show 事件次数（非去重用户）
 */

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
const SESSION_START = 'session_start';
const AD_SHOW = 'ad_show';
const HOME_PLATFORMS = ['wechat', 'douyin'] as const;

export type HomePlatform = (typeof HOME_PLATFORMS)[number];

export interface HomePlatformDau {
  platform: HomePlatform;
  label: string;
  dau: number;
  ad_show_cnt: number;
}

export interface HomeGameDau {
  game_key: string;
  display_name: string;
  total_dau: number;
  total_ad_show: number;
  /** 当月截至昨天（T-1）微信流量主真实收入，元 */
  month_t1_revenue_cny: number;
  platforms: HomePlatformDau[];
}

export interface HomeMonthlyGameSeries {
  game_key: string;
  display_name: string;
  revenue: number[];
}

export interface HomeMonthlyTrend {
  months: string[];
  games: HomeMonthlyGameSeries[];
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
  /** 全部游戏当月 T-1 收益合计 */
  month_t1_revenue_cny: number;
  monthly_trend: HomeMonthlyTrend;
  games: HomeGameDau[];
}

const PLATFORM_LABEL: Record<HomePlatform, string> = {
  wechat: '微信',
  douyin: '抖音',
};

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

/** 组装主页矩阵：游戏按 total_dau 降序；平台固定微信→抖音。 */
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
  const [dauRows, adShowRows, revenueMap, monthlyRowsRaw] = await Promise.all([
    queryTodayDauRows(fromTs, toTs, gameKeys),
    queryTodayAdShowRows(fromTs, toTs, gameKeys),
    sumBusinessDailyRevenueByGame(gameKeys, monthFromDate, monthT1Date),
    listBusinessMonthlyRevenue(gameKeys, fromMonth, toMonth),
  ]);
  let monthlyRows = monthlyRowsRaw;
  if (monthlyRows.length === 0 && gameKeys.length > 0) {
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

  const games: HomeGameDau[] = enabled.map((g) => {
    const platforms: HomePlatformDau[] = HOME_PLATFORMS.map((platform) => ({
      platform,
      label: PLATFORM_LABEL[platform],
      dau: dauMap.get(`${g.gameKey}\0${platform}`) || 0,
      ad_show_cnt: adShowMap.get(`${g.gameKey}\0${platform}`) || 0,
    }));
    const total_dau = platforms.reduce((sum, p) => sum + p.dau, 0);
    const total_ad_show = platforms.reduce((sum, p) => sum + p.ad_show_cnt, 0);
    const month_t1_revenue_cny = revenueMap.get(g.gameKey) || 0;
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
  const month_t1_revenue_cny =
    Math.round(games.reduce((sum, g) => sum + g.month_t1_revenue_cny, 0) * 100) / 100;

  const currentMonthKey = monthFromDate.slice(0, 7);
  const monthlyByGame = new Map<string, Map<string, number>>();
  for (const row of monthlyRows) {
    let byMonth = monthlyByGame.get(row.game_key);
    if (!byMonth) {
      byMonth = new Map();
      monthlyByGame.set(row.game_key, byMonth);
    }
    byMonth.set(row.month_key, row.revenue_cny);
  }
  const monthlyGames: HomeMonthlyGameSeries[] = games.map((g) => {
    const byMonth = monthlyByGame.get(g.game_key);
    const revenue = monthKeys.map((monthKey) => {
      if (monthKey === currentMonthKey) return g.month_t1_revenue_cny;
      return byMonth?.get(monthKey) || 0;
    });
    return { game_key: g.game_key, display_name: g.display_name, revenue };
  });
  const total = monthKeys.map((_, idx) =>
    Math.round(monthlyGames.reduce((sum, g) => sum + (g.revenue[idx] || 0), 0) * 100) / 100,
  );

  return {
    date_key: formatLocalDate(fromTs),
    from_ts: fromTs,
    to_ts: toTs,
    computed_at: now,
    month_from_date: monthFromDate,
    month_t1_date: monthT1Date,
    month_t1_revenue_cny,
    monthly_trend: { months: monthKeys, games: monthlyGames, total },
    games,
  };
}

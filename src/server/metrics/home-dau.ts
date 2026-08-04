import { getEnabledAnalyticsGames } from '../config/analytics-games';
import { getDb, getMysqlPool, isMysqlMode } from '../db';

/**
 * 经分主页：一次查出「今日」各游戏 × 微信/抖音的 DAU。
 * 口径与 overview 一致：session_start + COALESCE(NULLIF(user_id,''), anonymous_id)。
 */

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
const SESSION_START = 'session_start';
const HOME_PLATFORMS = ['wechat', 'douyin'] as const;

export type HomePlatform = (typeof HOME_PLATFORMS)[number];

export interface HomePlatformDau {
  platform: HomePlatform;
  label: string;
  dau: number;
}

export interface HomeGameDau {
  game_key: string;
  display_name: string;
  total_dau: number;
  platforms: HomePlatformDau[];
}

export interface HomeDauResult {
  date_key: string;
  from_ts: number;
  to_ts: number;
  computed_at: number;
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

interface RawRow {
  game_key: string;
  platform: string;
  dau: number;
}

async function queryTodayDauRows(fromTs: number, toTs: number, gameKeys: string[]): Promise<RawRow[]> {
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

  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(sql, params);
    return (rows as Array<{ game_key: string; platform: string; dau: number }>).map((r) => ({
      game_key: String(r.game_key),
      platform: String(r.platform || ''),
      dau: Number(r.dau || 0),
    }));
  }

  const rows = getDb()
    .prepare(sql)
    .all(...params) as Array<{ game_key: string; platform: string; dau: number }>;
  return rows.map((r) => ({
    game_key: String(r.game_key),
    platform: String(r.platform || ''),
    dau: Number(r.dau || 0),
  }));
}

/** 组装主页矩阵：游戏按 total_dau 降序；平台固定微信→抖音。 */
export async function getHomeDau(now = Date.now()): Promise<HomeDauResult> {
  const fromTs = startOfLocalDay(now);
  const toTs = now;
  const enabled = getEnabledAnalyticsGames();
  const gameKeys = enabled.map((g) => g.gameKey);
  const rows = await queryTodayDauRows(fromTs, toTs, gameKeys);

  const dauMap = new Map<string, number>();
  for (const row of rows) {
    if (!(HOME_PLATFORMS as readonly string[]).includes(row.platform)) continue;
    dauMap.set(`${row.game_key}\0${row.platform}`, row.dau);
  }

  const games: HomeGameDau[] = enabled.map((g) => {
    const platforms: HomePlatformDau[] = HOME_PLATFORMS.map((platform) => ({
      platform,
      label: PLATFORM_LABEL[platform],
      dau: dauMap.get(`${g.gameKey}\0${platform}`) || 0,
    }));
    const total_dau = platforms.reduce((sum, p) => sum + p.dau, 0);
    return {
      game_key: g.gameKey,
      display_name: g.displayName,
      total_dau,
      platforms,
    };
  });

  games.sort((a, b) => b.total_dau - a.total_dau || a.display_name.localeCompare(b.display_name, 'zh-CN'));

  return {
    date_key: formatLocalDate(fromTs),
    from_ts: fromTs,
    to_ts: toTs,
    computed_at: now,
    games,
  };
}

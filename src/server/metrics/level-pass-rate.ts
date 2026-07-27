import tcb from '@cloudbase/node-sdk';

import { getMysqlPool } from '../db';
import { findAnalyticsGame } from '../config/analytics-games';
import {
  PLATFORM_SQL,
  PRECOMPUTE_PLATFORMS,
  normalizePlatformFilter,
  platformSqlParams,
} from './platform-filter';

const MODE_KEY = 'bowl';
const WINDOW_DAYS = 30;
const MIN_SAMPLE_USERS = 10;
const PUBLIC_COLLECTION = 'hotpot_public_level_pass_rates';
const PUBLIC_DOC_ID = `${MODE_KEY}_${WINDOW_DAYS}d_latest`;
const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";

type LevelEventName = 'level_start' | 'level_clear' | 'level_fail';

interface RawLevelEvent {
  event_name: LevelEventName;
  level_id: number | null;
  user_key: string;
}

export interface LevelPassRateRow {
  game_key: string;
  mode_key: string;
  platform: string;
  level_id: number;
  window_days: number;
  window_start_date: string;
  window_end_date: string;
  start_users: number;
  clear_users: number;
  fail_users: number;
  started_and_cleared_users: number;
  start_attempts: number;
  clear_attempts: number;
  fail_attempts: number;
  pass_rate: number;
  is_sample_low: boolean;
  computed_at: number;
  updated_at: number;
}

export interface LevelPassRateSnapshot {
  game_key: string;
  mode_key: string;
  window_days: number;
  window_start_date: string;
  window_end_date: string;
  computed_at: number;
  levels: Array<{
    level_id: number;
    pass_rate: number;
    start_users: number;
    clear_users: number;
    started_and_cleared_users: number;
    is_sample_low: boolean;
  }>;
}

export interface RecomputeLevelPassRatesResult {
  game_key: string;
  mode_key: string;
  window_days: number;
  window_start_date: string;
  window_end_date: string;
  rows: number;
  published: boolean;
  computed_at: number;
}

export interface LevelPassRateOverview {
  game_key: string;
  mode_key: string;
  window_days: number;
  window_start_date: string;
  window_end_date: string;
  computed_at: number;
  levels: Array<{
    level_id: number;
    pass_rate: number;
    start_users: number;
    clear_users: number;
    started_and_cleared_users: number;
    start_attempts: number;
    clear_attempts: number;
    fail_attempts: number;
    is_sample_low: boolean;
  }>;
}

interface RecomputeOptions {
  gameKey?: string;
  windowDays?: number;
  publish?: boolean;
}

export async function recomputeLevelPassRates(options: RecomputeOptions = {}): Promise<RecomputeLevelPassRatesResult> {
  const gameKey = options.gameKey || 'hotpot';
  const windowDays = Math.max(1, Math.min(30, Math.floor(options.windowDays || WINDOW_DAYS)));
  const publish = options.publish !== false;
  const { fromDate, toDate, fromTs, toTs } = getCompleteDayWindow(windowDays);
  const computedAt = Date.now();
  await ensureLevelPassPlatformColumn();
  let totalRows = 0;
  let publishRows: LevelPassRateRow[] = [];
  for (const platform of PRECOMPUTE_PLATFORMS) {
    const rows = buildLevelPassRows(
      gameKey,
      await listRawLevelEvents(gameKey, fromTs, toTs, platform),
      {
        windowDays,
        fromDate,
        toDate,
        computedAt,
        platform,
      },
    );
    await replaceLevelPassRows(gameKey, MODE_KEY, windowDays, platform, rows);
    totalRows += rows.length;
    if (platform === 'wechat') publishRows = rows;
  }
  if (publish && gameKey === 'hotpot' && windowDays === WINDOW_DAYS) {
    await publishLevelPassRateSnapshot(publishRows, {
      gameKey,
      windowDays,
      fromDate,
      toDate,
      computedAt,
    });
  }
  return {
    game_key: gameKey,
    mode_key: MODE_KEY,
    window_days: windowDays,
    window_start_date: fromDate,
    window_end_date: toDate,
    rows: totalRows,
    published: publish && gameKey === 'hotpot' && windowDays === WINDOW_DAYS,
    computed_at: computedAt,
  };
}

export async function getLatestLevelPassRateOverview(
  gameKey = 'hotpot',
  windowDays = WINDOW_DAYS,
  platform?: string,
): Promise<LevelPassRateOverview | null> {
  const platformKey = normalizePlatformFilter(platform) || 'wechat';
  await ensureLevelPassPlatformColumn();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT
       game_key,
       mode_key,
       level_id,
       window_days,
       window_start_date,
       window_end_date,
       start_users,
       clear_users,
       started_and_cleared_users,
      start_attempts,
      clear_attempts,
      fail_attempts,
       pass_rate,
       is_sample_low,
       computed_at
     FROM game_level_pass_rates
     WHERE game_key = ? AND mode_key = ? AND window_days = ? AND platform = ?
     ORDER BY level_id ASC`,
    [gameKey, MODE_KEY, windowDays, platformKey],
  );
  const list = rows as Array<{
    game_key: string;
    mode_key: string;
    level_id: number;
    window_days: number;
    window_start_date: string;
    window_end_date: string;
    start_users: number;
    clear_users: number;
    started_and_cleared_users: number;
    start_attempts: number;
    clear_attempts: number;
    fail_attempts: number;
    pass_rate: number;
    is_sample_low: number;
    computed_at: number;
  }>;
  const first = list[0];
  if (!first) {
    // 冷启动兜底：预聚合尚未回算完时临时实时算一次
    return computeLiveLevelPassRateOverview(gameKey, windowDays, platformKey);
  }
  return {
    game_key: first.game_key,
    mode_key: first.mode_key,
    window_days: Number(first.window_days),
    window_start_date: String(first.window_start_date),
    window_end_date: String(first.window_end_date),
    computed_at: Number(first.computed_at),
    levels: list.map((row) => ({
      level_id: Number(row.level_id),
      pass_rate: Number(row.pass_rate),
      start_users: Number(row.start_users),
      clear_users: Number(row.clear_users),
      started_and_cleared_users: Number(row.started_and_cleared_users),
      start_attempts: Number(row.start_attempts),
      clear_attempts: Number(row.clear_attempts),
      fail_attempts: Number(row.fail_attempts),
      is_sample_low: Boolean(row.is_sample_low),
    })),
  };
}

/** 预聚合暂无该平台数据时的实时兜底（不落库）。 */
async function computeLiveLevelPassRateOverview(
  gameKey: string,
  windowDays: number,
  platform?: string,
): Promise<LevelPassRateOverview> {
  const boundedWindowDays = Math.max(1, Math.min(30, Math.floor(windowDays || WINDOW_DAYS)));
  const { fromDate, toDate, fromTs, toTs } = getCompleteDayWindow(boundedWindowDays);
  const computedAt = Date.now();
  const platformKey = normalizePlatformFilter(platform) || 'wechat';
  const rows = buildLevelPassRows(
    gameKey,
    await listRawLevelEvents(gameKey, fromTs, toTs, platformKey),
    { windowDays: boundedWindowDays, fromDate, toDate, computedAt, platform: platformKey },
  );
  return {
    game_key: gameKey,
    mode_key: MODE_KEY,
    window_days: boundedWindowDays,
    window_start_date: fromDate,
    window_end_date: toDate,
    computed_at: computedAt,
    levels: rows.map((row) => ({
      level_id: row.level_id,
      pass_rate: row.pass_rate,
      start_users: row.start_users,
      clear_users: row.clear_users,
      started_and_cleared_users: row.started_and_cleared_users,
      start_attempts: row.start_attempts,
      clear_attempts: row.clear_attempts,
      fail_attempts: row.fail_attempts,
      is_sample_low: row.is_sample_low,
    })),
  };
}

async function ensureLevelPassPlatformColumn(): Promise<void> {
  const pool = await getMysqlPool();
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME AS name
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'game_level_pass_rates'
        AND COLUMN_NAME = 'platform'`,
  );
  if ((cols as Array<{ name: string }>).length) return;
  await pool.query(`
    ALTER TABLE game_level_pass_rates
      ADD COLUMN platform VARCHAR(16) NOT NULL DEFAULT '' AFTER mode_key
  `);
  await pool.query(`
    ALTER TABLE game_level_pass_rates
      DROP PRIMARY KEY,
      ADD PRIMARY KEY (game_key, mode_key, platform, level_id, window_days)
  `);
}

function getCompleteDayWindow(windowDays: number): { fromDate: string; toDate: string; fromTs: number; toTs: number } {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const toStart = new Date(todayStart.getTime() - 86_400_000);
  const fromStart = new Date(todayStart.getTime() - windowDays * 86_400_000);
  return {
    fromDate: toLocalDateKey(fromStart),
    toDate: toLocalDateKey(toStart),
    fromTs: fromStart.getTime(),
    toTs: toStart.getTime() + 86_400_000 - 1,
  };
}

function toLocalDateKey(date: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function listRawLevelEvents(gameKey: string, fromTs: number, toTs: number, platform?: string): Promise<RawLevelEvent[]> {
  const pool = await getMysqlPool();
  const platformParams = platformSqlParams(platform);
  const [rows] = await pool.query(
    `SELECT
       event_name,
       CAST(JSON_EXTRACT(params_json, '$.level_id') AS SIGNED) AS level_id,
       ${USER_KEY_SQL} AS user_key
     FROM analytics_events
     WHERE game_key = ?
       AND event_name IN ('level_start', 'level_clear', 'level_fail')
       AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`,
    [gameKey, fromTs, toTs, ...platformParams],
  );
  return rows as RawLevelEvent[];
}

function buildLevelPassRows(
  gameKey: string,
  events: RawLevelEvent[],
  opts: { windowDays: number; fromDate: string; toDate: string; computedAt: number; platform: string },
): LevelPassRateRow[] {
  const byLevel = new Map<number, {
    startUsers: Set<string>;
    clearUsers: Set<string>;
    failUsers: Set<string>;
    startAttempts: number;
    clearAttempts: number;
    failAttempts: number;
  }>();
  for (const event of events) {
    const levelId = Number(event.level_id);
    const userKey = String(event.user_key || '');
    if (!Number.isFinite(levelId) || levelId <= 0 || !userKey) continue;
    const acc = byLevel.get(levelId) || {
      startUsers: new Set<string>(),
      clearUsers: new Set<string>(),
      failUsers: new Set<string>(),
      startAttempts: 0,
      clearAttempts: 0,
      failAttempts: 0,
    };
    if (event.event_name === 'level_start') {
      acc.startUsers.add(userKey);
      acc.startAttempts += 1;
    } else if (event.event_name === 'level_clear') {
      acc.clearUsers.add(userKey);
      acc.clearAttempts += 1;
    } else if (event.event_name === 'level_fail') {
      acc.failUsers.add(userKey);
      acc.failAttempts += 1;
    }
    byLevel.set(levelId, acc);
  }

  return Array.from(byLevel.entries())
    .sort(([a], [b]) => a - b)
    .map(([levelId, acc]) => {
      const startedAndCleared = Array.from(acc.startUsers).filter((userKey) => acc.clearUsers.has(userKey)).length;
      const startUsers = acc.startUsers.size;
      return {
        game_key: gameKey,
        mode_key: MODE_KEY,
        platform: opts.platform,
        level_id: levelId,
        window_days: opts.windowDays,
        window_start_date: opts.fromDate,
        window_end_date: opts.toDate,
        start_users: startUsers,
        clear_users: acc.clearUsers.size,
        fail_users: acc.failUsers.size,
        started_and_cleared_users: startedAndCleared,
        start_attempts: acc.startAttempts,
        clear_attempts: acc.clearAttempts,
        fail_attempts: acc.failAttempts,
        pass_rate: startUsers > 0 ? Math.round((startedAndCleared / startUsers) * 10_000) / 10_000 : 0,
        is_sample_low: startUsers < MIN_SAMPLE_USERS,
        computed_at: opts.computedAt,
        updated_at: Date.now(),
      };
    });
}

async function replaceLevelPassRows(
  gameKey: string,
  modeKey: string,
  windowDays: number,
  platform: string,
  rows: LevelPassRateRow[],
): Promise<void> {
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      'DELETE FROM game_level_pass_rates WHERE game_key = ? AND mode_key = ? AND window_days = ? AND platform = ?',
      [gameKey, modeKey, windowDays, platform],
    );
    for (const row of rows) {
      await conn.execute(
        `INSERT INTO game_level_pass_rates (
          game_key, mode_key, platform, level_id, window_days, window_start_date, window_end_date,
          start_users, clear_users, fail_users, started_and_cleared_users,
          start_attempts, clear_attempts, fail_attempts, pass_rate, is_sample_low,
          computed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.game_key,
          row.mode_key,
          row.platform,
          row.level_id,
          row.window_days,
          row.window_start_date,
          row.window_end_date,
          row.start_users,
          row.clear_users,
          row.fail_users,
          row.started_and_cleared_users,
          row.start_attempts,
          row.clear_attempts,
          row.fail_attempts,
          row.pass_rate,
          row.is_sample_low ? 1 : 0,
          row.computed_at,
          row.updated_at,
        ],
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function publishLevelPassRateSnapshot(
  rows: LevelPassRateRow[],
  opts: { gameKey: string; windowDays: number; fromDate: string; toDate: string; computedAt: number },
): Promise<void> {
  const game = findAnalyticsGame(opts.gameKey);
  if (!game) {
    throw new Error(`unknown analytics game: ${opts.gameKey}`);
  }
  const secretId = process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '';
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '';
  const sessionToken = process.env.TENCENTCLOUD_SESSION_TOKEN || process.env.TENCENTCLOUD_TOKEN || '';
  if (!secretId || !secretKey) {
    throw new Error('缺少腾讯云密钥，请设置 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY');
  }
  const app = tcb.init({
    env: game.cloudEnv,
    secretId,
    secretKey,
    sessionToken: sessionToken || undefined,
  });
  const snapshot: LevelPassRateSnapshot = {
    game_key: opts.gameKey,
    mode_key: MODE_KEY,
    window_days: opts.windowDays,
    window_start_date: opts.fromDate,
    window_end_date: opts.toDate,
    computed_at: opts.computedAt,
    levels: rows.map((row) => ({
      level_id: row.level_id,
      pass_rate: row.pass_rate,
      start_users: row.start_users,
      clear_users: row.clear_users,
      started_and_cleared_users: row.started_and_cleared_users,
      is_sample_low: row.is_sample_low,
    })),
  };
  await app.database().collection(PUBLIC_COLLECTION).doc(PUBLIC_DOC_ID).set(snapshot);
}

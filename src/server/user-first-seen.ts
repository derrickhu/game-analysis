import { getMysqlPool } from './db';
import { platformSqlParams } from './metrics/platform-filter';
import { toShanghaiDateKey } from './time';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";

/**
 * 最早一次 session_start。
 * 事件表只留 7 天后，新增、留存、LTV 仍用这张表认 cohort，避免老用户被回算成新用户。
 * 读的时候再并上事件表里还在的 session_start，刚进来、还没刷进表的用户也不会漏。
 */
export const DURABLE_FIRST_SEEN_SQL = `
SELECT user_key AS uk, MIN(first_ts) AS first_ts
  FROM (
    SELECT user_key, first_ts
      FROM analytics_user_first_seen
     WHERE game_key = ?
       AND (? = '' OR platform = ?)
    UNION ALL
    SELECT ${USER_KEY_SQL} AS user_key, event_ts AS first_ts
      FROM analytics_events
     WHERE game_key = ?
       AND event_name = 'session_start'
       AND (? = '' OR platform = ?)
       AND ${USER_KEY_SQL} <> ''
  ) first_src
 GROUP BY user_key
`;

let tableReady = false;

export function durableFirstSeenParams(gameKey: string, platform?: string | null): string[] {
  const [platformA, platformB] = platformSqlParams(platform);
  return [gameKey, platformA, platformB, gameKey, platformA, platformB];
}

export async function ensureUserFirstSeenTable(): Promise<void> {
  if (tableReady) return;
  const pool = await getMysqlPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_user_first_seen (
      game_key VARCHAR(32) NOT NULL,
      platform VARCHAR(16) NOT NULL,
      user_key VARCHAR(128) NOT NULL,
      user_id VARCHAR(128) NOT NULL DEFAULT '',
      anonymous_id VARCHAR(64) NOT NULL DEFAULT '',
      first_ts BIGINT NOT NULL,
      first_seen_date VARCHAR(10) NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, platform, user_key),
      INDEX idx_game_first_ts (game_key, first_ts),
      INDEX idx_game_platform_date (game_key, platform, first_seen_date)
    )
  `);
  tableReady = true;
}

interface FirstSeenSeed {
  game_key: string;
  platform: string;
  user_key: string;
  user_id: string;
  anonymous_id: string;
  first_ts: number;
}

/** 用当前事件表里的 session_start 补齐首次出现。已有更早记录时不往后改。 */
export async function refreshUserFirstSeen(gameKey?: string): Promise<number> {
  await ensureUserFirstSeenTable();
  const pool = await getMysqlPool();
  const where = [`event_name = 'session_start'`, `${USER_KEY_SQL} <> ''`];
  const params: unknown[] = [];
  if (gameKey) {
    where.push('game_key = ?');
    params.push(gameKey);
  }
  const [rows] = await pool.query(
    `SELECT game_key,
            IFNULL(platform, '') AS platform,
            ${USER_KEY_SQL} AS user_key,
            MAX(user_id) AS user_id,
            MAX(anonymous_id) AS anonymous_id,
            MIN(event_ts) AS first_ts
       FROM analytics_events
      WHERE ${where.join(' AND ')}
      GROUP BY game_key, IFNULL(platform, ''), ${USER_KEY_SQL}`,
    params,
  );
  const seeds = (rows as FirstSeenSeed[]).filter((row) => row.user_key && row.game_key);
  const now = Date.now();
  const chunkSize = 500;
  let written = 0;
  for (let i = 0; i < seeds.length; i += chunkSize) {
    const slice = seeds.slice(i, i + chunkSize);
    const values: unknown[] = [];
    for (const row of slice) {
      values.push(
        String(row.game_key).slice(0, 32),
        String(row.platform || '').slice(0, 16),
        String(row.user_key).slice(0, 128),
        String(row.user_id || '').slice(0, 128),
        String(row.anonymous_id || '').slice(0, 64),
        Number(row.first_ts),
        toShanghaiDateKey(Number(row.first_ts)),
        now,
      );
    }
    await pool.query(
      `INSERT INTO analytics_user_first_seen
         (game_key, platform, user_key, user_id, anonymous_id, first_ts, first_seen_date, updated_at)
       VALUES ${slice.map(() => '(?,?,?,?,?,?,?,?)').join(',')}
       ON DUPLICATE KEY UPDATE
         first_seen_date = IF(VALUES(first_ts) < first_ts, VALUES(first_seen_date), first_seen_date),
         first_ts = LEAST(first_ts, VALUES(first_ts)),
         user_id = IF(user_id = '', VALUES(user_id), user_id),
         anonymous_id = IF(anonymous_id = '', VALUES(anonymous_id), anonymous_id),
         updated_at = VALUES(updated_at)`,
      values,
    );
    written += slice.length;
  }
  return written;
}

/** 清理原始事件和回算日活不要叠在一起，否则首次出现可能被截短。 */
export async function withRawRetentionLock<T>(task: () => Promise<T>, waitSeconds = 180): Promise<T> {
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  const wait = Math.max(1, Math.min(900, Math.floor(waitSeconds)));
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(\'ga_raw_retention\', ?) AS got', [wait]);
    if (Number((rows as Array<{ got: number | null }>)[0]?.got) !== 1) {
      throw new Error('ga_raw_retention lock timeout');
    }
    return await task();
  } finally {
    try {
      await conn.query("SELECT RELEASE_LOCK('ga_raw_retention')");
    } finally {
      conn.release();
    }
  }
}

export async function queryDurableFirstSeen(
  gameKey: string,
  platform?: string | null,
): Promise<Array<{ uk: string; first_ts: number }>> {
  await ensureUserFirstSeenTable();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(DURABLE_FIRST_SEEN_SQL, durableFirstSeenParams(gameKey, platform));
  return (rows as Array<{ uk: string; first_ts: number }>).filter((row) => row.uk);
}

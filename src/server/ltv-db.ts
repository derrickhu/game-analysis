import type mysql from 'mysql2/promise';

import { getMysqlPool, isMysqlMode } from './db';

let migratedMysql = false;

export interface UserDailyRow {
  game_key: string;
  date_key: string;
  user_key: string;
  first_seen_date: string;
  is_new_user: number;
  is_active: number;
  session_cnt: number;
  session_duration_ms: number;
  ad_request_cnt: number;
  ad_show_cnt: number;
  ad_complete_cnt: number;
  ad_error_cnt: number;
  ad_revenue_estimated_cny: number;
  level_start_cnt: number;
  level_clear_cnt: number;
  level_fail_cnt: number;
  share_cnt: number;
  created_at: number;
  updated_at: number;
}

export interface CohortLtvDailyRow {
  game_key: string;
  cohort_date: string;
  age_day: number;
  cohort_size: number;
  active_users: number;
  retained_users: number;
  ad_show_cnt: number;
  ad_revenue_estimated_cny: number;
  iap_revenue_cny: number;
  total_revenue_cny: number;
  ltv_cny: number;
  retention_rate: number;
  is_complete_day: number;
  updated_at: number;
}

export interface BusinessDailyInputRow {
  id: number;
  game_key: string;
  date_key: string;
  spend_cny: number;
  wechat_clicks: number;
  wechat_ad_revenue_cny: number;
  wechat_ad_impressions: number;
  note: string;
  created_at: number;
  updated_at: number;
}

export interface BusinessDailyInputDraft {
  game_key: string;
  date_key: string;
  spend_cny: number;
  wechat_clicks: number;
  wechat_ad_revenue_cny: number;
  wechat_ad_impressions: number;
  note?: string;
}

async function migrateMysql(pool: mysql.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_user_daily (
      game_key VARCHAR(32) NOT NULL,
      date_key VARCHAR(10) NOT NULL,
      user_key VARCHAR(191) NOT NULL,
      first_seen_date VARCHAR(10) NOT NULL,
      is_new_user TINYINT NOT NULL DEFAULT 0,
      is_active TINYINT NOT NULL DEFAULT 1,
      session_cnt INT NOT NULL DEFAULT 0,
      session_duration_ms BIGINT NOT NULL DEFAULT 0,
      ad_request_cnt INT NOT NULL DEFAULT 0,
      ad_show_cnt INT NOT NULL DEFAULT 0,
      ad_complete_cnt INT NOT NULL DEFAULT 0,
      ad_error_cnt INT NOT NULL DEFAULT 0,
      ad_revenue_estimated_cny DOUBLE NOT NULL DEFAULT 0,
      level_start_cnt INT NOT NULL DEFAULT 0,
      level_clear_cnt INT NOT NULL DEFAULT 0,
      level_fail_cnt INT NOT NULL DEFAULT 0,
      share_cnt INT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, date_key, user_key),
      INDEX idx_game_first_seen (game_key, first_seen_date),
      INDEX idx_game_user_date (game_key, user_key, date_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_cohort_ltv_daily (
      game_key VARCHAR(32) NOT NULL,
      cohort_date VARCHAR(10) NOT NULL,
      age_day INT NOT NULL,
      cohort_size INT NOT NULL DEFAULT 0,
      active_users INT NOT NULL DEFAULT 0,
      retained_users INT NOT NULL DEFAULT 0,
      ad_show_cnt INT NOT NULL DEFAULT 0,
      ad_revenue_estimated_cny DOUBLE NOT NULL DEFAULT 0,
      iap_revenue_cny DOUBLE NOT NULL DEFAULT 0,
      total_revenue_cny DOUBLE NOT NULL DEFAULT 0,
      ltv_cny DOUBLE NOT NULL DEFAULT 0,
      retention_rate DOUBLE NOT NULL DEFAULT 0,
      is_complete_day TINYINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, cohort_date, age_day),
      INDEX idx_game_age (game_key, age_day),
      INDEX idx_game_cohort (game_key, cohort_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_daily_inputs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      game_key VARCHAR(32) NOT NULL,
      date_key VARCHAR(10) NOT NULL,
      spend_cny DOUBLE NOT NULL DEFAULT 0,
      wechat_clicks INT NOT NULL DEFAULT 0,
      wechat_ad_revenue_cny DOUBLE NOT NULL DEFAULT 0,
      wechat_ad_impressions INT NOT NULL DEFAULT 0,
      note TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE KEY uniq_game_date (game_key, date_key),
      INDEX idx_game_date (game_key, date_key)
    )
  `);
}

export async function ensureLtvTables(): Promise<void> {
  if (!isMysqlMode()) {
    throw new Error('LTV 指标当前仅支持 MySQL 存储');
  }
  if (migratedMysql) return;
  const pool = await getMysqlPool();
  await migrateMysql(pool);
  migratedMysql = true;
}

export async function replaceUserDailyRows(
  gameKey: string,
  fromDate: string,
  toDate: string,
  rows: UserDailyRow[],
): Promise<number> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM analytics_user_daily
        WHERE game_key = ? AND date_key BETWEEN ? AND ?`,
      [gameKey, fromDate, toDate],
    );
    if (rows.length > 0) {
      const cols = [
        'game_key',
        'date_key',
        'user_key',
        'first_seen_date',
        'is_new_user',
        'is_active',
        'session_cnt',
        'session_duration_ms',
        'ad_request_cnt',
        'ad_show_cnt',
        'ad_complete_cnt',
        'ad_error_cnt',
        'ad_revenue_estimated_cny',
        'level_start_cnt',
        'level_clear_cnt',
        'level_fail_cnt',
        'share_cnt',
        'created_at',
        'updated_at',
      ];
      const placeholders = `(${cols.map(() => '?').join(',')})`;
      const values: unknown[] = [];
      for (const row of rows) {
        for (const col of cols) values.push((row as unknown as Record<string, unknown>)[col]);
      }
      await conn.query(
        `INSERT INTO analytics_user_daily (${cols.join(',')})
         VALUES ${rows.map(() => placeholders).join(',')}`,
        values,
      );
    }
    await conn.commit();
    return rows.length;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function replaceCohortLtvRows(
  gameKey: string,
  fromCohortDate: string,
  toCohortDate: string,
  rows: CohortLtvDailyRow[],
): Promise<number> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM analytics_cohort_ltv_daily
        WHERE game_key = ? AND cohort_date BETWEEN ? AND ?`,
      [gameKey, fromCohortDate, toCohortDate],
    );
    if (rows.length > 0) {
      const cols = [
        'game_key',
        'cohort_date',
        'age_day',
        'cohort_size',
        'active_users',
        'retained_users',
        'ad_show_cnt',
        'ad_revenue_estimated_cny',
        'iap_revenue_cny',
        'total_revenue_cny',
        'ltv_cny',
        'retention_rate',
        'is_complete_day',
        'updated_at',
      ];
      const placeholders = `(${cols.map(() => '?').join(',')})`;
      const values: unknown[] = [];
      for (const row of rows) {
        for (const col of cols) values.push((row as unknown as Record<string, unknown>)[col]);
      }
      await conn.query(
        `INSERT INTO analytics_cohort_ltv_daily (${cols.join(',')})
         VALUES ${rows.map(() => placeholders).join(',')}`,
        values,
      );
    }
    await conn.commit();
    return rows.length;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function listUserDailyRows(gameKey: string): Promise<UserDailyRow[]> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM analytics_user_daily
      WHERE game_key = ?
      ORDER BY first_seen_date ASC, date_key ASC`,
    [gameKey],
  );
  return rows as UserDailyRow[];
}

export async function listCohortLtvRows(
  gameKey: string,
  fromCohortDate: string,
  toCohortDate: string,
): Promise<CohortLtvDailyRow[]> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM analytics_cohort_ltv_daily
      WHERE game_key = ? AND cohort_date BETWEEN ? AND ?
      ORDER BY cohort_date ASC, age_day ASC`,
    [gameKey, fromCohortDate, toCohortDate],
  );
  return rows as CohortLtvDailyRow[];
}

export async function upsertBusinessDailyInput(input: BusinessDailyInputDraft): Promise<BusinessDailyInputRow> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const now = Date.now();
  await pool.query(
    `INSERT INTO business_daily_inputs (
       game_key, date_key, spend_cny, wechat_clicks, wechat_ad_revenue_cny,
       wechat_ad_impressions, note, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       spend_cny = VALUES(spend_cny),
       wechat_clicks = VALUES(wechat_clicks),
       wechat_ad_revenue_cny = VALUES(wechat_ad_revenue_cny),
       wechat_ad_impressions = VALUES(wechat_ad_impressions),
       note = VALUES(note),
       updated_at = VALUES(updated_at)`,
    [
      input.game_key,
      input.date_key,
      input.spend_cny,
      input.wechat_clicks,
      input.wechat_ad_revenue_cny,
      input.wechat_ad_impressions,
      input.note || '',
      now,
      now,
    ],
  );
  const [rows] = await pool.query(
    `SELECT * FROM business_daily_inputs WHERE game_key = ? AND date_key = ?`,
    [input.game_key, input.date_key],
  );
  return (rows as BusinessDailyInputRow[])[0];
}

export async function deleteBusinessDailyInput(gameKey: string, dateKey: string): Promise<number> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const [result] = await pool.query(
    `DELETE FROM business_daily_inputs WHERE game_key = ? AND date_key = ?`,
    [gameKey, dateKey],
  );
  return Number((result as mysql.ResultSetHeader).affectedRows || 0);
}

export async function listBusinessDailyInputs(
  gameKey: string,
  fromDate: string,
  toDate: string,
): Promise<BusinessDailyInputRow[]> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM business_daily_inputs
      WHERE game_key = ? AND date_key BETWEEN ? AND ?
      ORDER BY date_key DESC`,
    [gameKey, fromDate, toDate],
  );
  return rows as BusinessDailyInputRow[];
}

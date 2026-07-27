import type mysql from 'mysql2/promise';

import { getMysqlPool, isMysqlMode } from './db';

let migratedMysql = false;

export interface UserDailyRow {
  game_key: string;
  date_key: string;
  user_key: string;
  /** wechat / douyin；历史混算行为 '' */
  platform: string;
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
  /** wechat / douyin；历史混算行为 '' */
  platform: string;
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
  acquisition_impressions: number;
  acquisition_activations: number;
  acquisition_source: string;
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
  acquisition_impressions?: number;
  acquisition_activations?: number;
  acquisition_source?: string;
  note?: string;
}

export interface WechatPublisherAdDailyRow {
  game_key: string;
  date_key: string;
  slot_id: string;
  ad_slot: string;
  req_succ_count: number;
  exposure_count: number;
  exposure_rate: number;
  click_count: number;
  click_rate: number;
  income_cny: number;
  ecpm_cny: number;
  raw_json: string;
  updated_at: number;
}

export interface WechatPublisherIngestRunDraft {
  trigger_source: string;
  game_key?: string;
  from_date: string;
  to_date: string;
  ok: boolean;
  games_json: string;
  error_message?: string;
  started_at: number;
  finished_at: number;
  duration_ms: number;
}

export interface TencentAdsDailyReportRawRow {
  game_key: string;
  account_id: string;
  report_level: string;
  date_key: string;
  adgroup_id: string;
  adgroup_name: string;
  cost_cny: number;
  impression: number | null;
  click: number | null;
  activation: number | null;
  missing_fields_json: string;
  raw_json: string;
  updated_at: number;
}

export interface TencentAdsTargetingTagReportRawRow {
  game_key: string;
  account_id: string;
  report_level: string;
  date_key: string;
  dimension_type: string;
  dimension_value: string;
  cost_cny: number;
  impression: number | null;
  click: number | null;
  activation: number | null;
  missing_fields_json: string;
  raw_json: string;
  updated_at: number;
}

export interface TencentAdsCreativeReportRawRow {
  game_key: string;
  account_id: string;
  report_level: string;
  date_key: string;
  adgroup_id: string;
  entity_type: string;
  entity_id: string;
  entity_name: string;
  site_set: string;
  cost_cny: number;
  impression: number | null;
  click: number | null;
  activation: number | null;
  missing_fields_json: string;
  raw_json: string;
  updated_at: number;
}

export interface TencentAdsAudienceInsightRawRow {
  game_key: string;
  account_id: string;
  audience_id: string;
  dimension_type: string;
  dimension_value: string;
  match_rate: number | null;
  percentage: number | null;
  tgi: number | null;
  raw_json: string;
  updated_at: number;
}

async function addMysqlColumnIfMissing(pool: mysql.Pool, tableName: string, columnName: string, ddl: string): Promise<void> {
  try {
    await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${ddl}`);
  } catch (error) {
    const err = error as { code?: string };
    if (err.code !== 'ER_DUP_FIELDNAME') {
      throw error;
    }
  }
}

async function hasMysqlColumn(pool: mysql.Pool, tableName: string, columnName: string): Promise<boolean> {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName],
  );
  return (rows as Array<{ name: string }>).length > 0;
}

async function ensurePlatformOnUserDaily(pool: mysql.Pool): Promise<void> {
  if (!(await hasMysqlColumn(pool, 'analytics_user_daily', 'platform'))) {
    await pool.query(`
      ALTER TABLE analytics_user_daily
        ADD COLUMN platform VARCHAR(16) NOT NULL DEFAULT '' AFTER user_key
    `);
    await pool.query(`
      ALTER TABLE analytics_user_daily
        DROP PRIMARY KEY,
        ADD PRIMARY KEY (game_key, date_key, user_key, platform)
    `);
    await pool.query(`
      CREATE INDEX idx_game_platform_date
        ON analytics_user_daily (game_key, platform, date_key)
    `).catch(() => undefined);
  }
}

async function ensurePlatformOnCohortLtv(pool: mysql.Pool): Promise<void> {
  if (!(await hasMysqlColumn(pool, 'analytics_cohort_ltv_daily', 'platform'))) {
    await pool.query(`
      ALTER TABLE analytics_cohort_ltv_daily
        ADD COLUMN platform VARCHAR(16) NOT NULL DEFAULT '' AFTER cohort_date
    `);
    await pool.query(`
      ALTER TABLE analytics_cohort_ltv_daily
        DROP PRIMARY KEY,
        ADD PRIMARY KEY (game_key, cohort_date, platform, age_day)
    `);
    await pool.query(`
      CREATE INDEX idx_game_platform_cohort
        ON analytics_cohort_ltv_daily (game_key, platform, cohort_date)
    `).catch(() => undefined);
  }
}

async function migrateMysql(pool: mysql.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_user_daily (
      game_key VARCHAR(32) NOT NULL,
      date_key VARCHAR(10) NOT NULL,
      user_key VARCHAR(191) NOT NULL,
      platform VARCHAR(16) NOT NULL DEFAULT '',
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
      PRIMARY KEY (game_key, date_key, user_key, platform),
      INDEX idx_game_first_seen (game_key, first_seen_date),
      INDEX idx_game_user_date (game_key, user_key, date_key),
      INDEX idx_game_platform_date (game_key, platform, date_key)
    )
  `);
  await ensurePlatformOnUserDaily(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_cohort_ltv_daily (
      game_key VARCHAR(32) NOT NULL,
      cohort_date VARCHAR(10) NOT NULL,
      platform VARCHAR(16) NOT NULL DEFAULT '',
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
      PRIMARY KEY (game_key, cohort_date, platform, age_day),
      INDEX idx_game_age (game_key, age_day),
      INDEX idx_game_cohort (game_key, cohort_date),
      INDEX idx_game_platform_cohort (game_key, platform, cohort_date)
    )
  `);
  await ensurePlatformOnCohortLtv(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_daily_inputs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      game_key VARCHAR(32) NOT NULL,
      date_key VARCHAR(10) NOT NULL,
      spend_cny DOUBLE NOT NULL DEFAULT 0,
      wechat_clicks INT NOT NULL DEFAULT 0,
      wechat_ad_revenue_cny DOUBLE NOT NULL DEFAULT 0,
      wechat_ad_impressions INT NOT NULL DEFAULT 0,
      acquisition_impressions BIGINT NOT NULL DEFAULT 0,
      acquisition_activations BIGINT NOT NULL DEFAULT 0,
      acquisition_source VARCHAR(64) NOT NULL DEFAULT '',
      note TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE KEY uniq_game_date (game_key, date_key),
      INDEX idx_game_date (game_key, date_key)
    )
  `);
  await addMysqlColumnIfMissing(pool, 'business_daily_inputs', 'acquisition_impressions', "BIGINT NOT NULL DEFAULT 0 AFTER wechat_ad_impressions");
  await addMysqlColumnIfMissing(pool, 'business_daily_inputs', 'acquisition_activations', "BIGINT NOT NULL DEFAULT 0 AFTER acquisition_impressions");
  await addMysqlColumnIfMissing(pool, 'business_daily_inputs', 'acquisition_source', "VARCHAR(64) NOT NULL DEFAULT '' AFTER acquisition_activations");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wechat_publisher_ad_daily (
      game_key VARCHAR(32) NOT NULL,
      date_key VARCHAR(10) NOT NULL,
      slot_id VARCHAR(64) NOT NULL,
      ad_slot VARCHAR(128) NOT NULL,
      req_succ_count BIGINT NOT NULL DEFAULT 0,
      exposure_count BIGINT NOT NULL DEFAULT 0,
      exposure_rate DOUBLE NOT NULL DEFAULT 0,
      click_count BIGINT NOT NULL DEFAULT 0,
      click_rate DOUBLE NOT NULL DEFAULT 0,
      income_cny DOUBLE NOT NULL DEFAULT 0,
      ecpm_cny DOUBLE NOT NULL DEFAULT 0,
      raw_json JSON NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, date_key, slot_id),
      INDEX idx_game_date (game_key, date_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS wechat_publisher_ingest_runs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      trigger_source VARCHAR(16) NOT NULL,
      game_key VARCHAR(32) NOT NULL DEFAULT '',
      from_date VARCHAR(10) NOT NULL,
      to_date VARCHAR(10) NOT NULL,
      ok TINYINT NOT NULL DEFAULT 0,
      games_json JSON NOT NULL,
      error_message TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      finished_at BIGINT NOT NULL,
      duration_ms BIGINT NOT NULL,
      INDEX idx_started_at (started_at),
      INDEX idx_range (from_date, to_date),
      INDEX idx_game_started (game_key, started_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tencent_ads_daily_reports_raw (
      game_key VARCHAR(32) NOT NULL,
      account_id VARCHAR(32) NOT NULL,
      report_level VARCHAR(64) NOT NULL,
      date_key VARCHAR(10) NOT NULL,
      adgroup_id VARCHAR(64) NOT NULL,
      adgroup_name VARCHAR(255) NOT NULL,
      cost_cny DOUBLE NOT NULL DEFAULT 0,
      impression BIGINT NULL,
      click BIGINT NULL,
      activation BIGINT NULL,
      missing_fields_json JSON NOT NULL,
      raw_json JSON NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, account_id, report_level, date_key, adgroup_id),
      INDEX idx_game_date (game_key, date_key)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tencent_ads_targeting_tag_reports_raw (
      game_key VARCHAR(32) NOT NULL,
      account_id VARCHAR(32) NOT NULL,
      report_level VARCHAR(64) NOT NULL,
      date_key VARCHAR(10) NOT NULL,
      dimension_type VARCHAR(32) NOT NULL,
      dimension_value VARCHAR(128) NOT NULL,
      cost_cny DOUBLE NOT NULL DEFAULT 0,
      impression BIGINT NULL,
      click BIGINT NULL,
      activation BIGINT NULL,
      missing_fields_json JSON NOT NULL,
      raw_json JSON NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, account_id, report_level, date_key, dimension_type, dimension_value),
      INDEX idx_game_date (game_key, date_key),
      INDEX idx_game_dimension (game_key, dimension_type, dimension_value)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tencent_ads_creative_reports_raw (
      game_key VARCHAR(32) NOT NULL,
      account_id VARCHAR(32) NOT NULL,
      report_level VARCHAR(64) NOT NULL,
      date_key VARCHAR(10) NOT NULL,
      adgroup_id VARCHAR(64) NOT NULL,
      entity_type VARCHAR(64) NOT NULL,
      entity_id VARCHAR(128) NOT NULL,
      entity_name VARCHAR(255) NOT NULL,
      site_set VARCHAR(64) NOT NULL DEFAULT '',
      cost_cny DOUBLE NOT NULL DEFAULT 0,
      impression BIGINT NULL,
      click BIGINT NULL,
      activation BIGINT NULL,
      missing_fields_json JSON NOT NULL,
      raw_json JSON NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, account_id, report_level, date_key, adgroup_id, entity_type, entity_id, site_set),
      INDEX idx_game_date (game_key, date_key),
      INDEX idx_game_entity (game_key, report_level, entity_type, entity_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tencent_ads_audience_insights_raw (
      game_key VARCHAR(32) NOT NULL,
      account_id VARCHAR(32) NOT NULL,
      audience_id VARCHAR(64) NOT NULL,
      dimension_type VARCHAR(64) NOT NULL,
      dimension_value VARCHAR(255) NOT NULL,
      match_rate DOUBLE NULL,
      percentage DOUBLE NULL,
      tgi DOUBLE NULL,
      raw_json JSON NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, account_id, audience_id, dimension_type, dimension_value),
      INDEX idx_game_audience (game_key, audience_id),
      INDEX idx_game_dimension (game_key, dimension_type, dimension_value)
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
  platform: string,
  rows: UserDailyRow[],
): Promise<number> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM analytics_user_daily
        WHERE game_key = ? AND platform = ? AND date_key BETWEEN ? AND ?`,
      [gameKey, platform, fromDate, toDate],
    );
    if (rows.length > 0) {
      const cols = [
        'game_key',
        'date_key',
        'user_key',
        'platform',
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
  platform: string,
  rows: CohortLtvDailyRow[],
): Promise<number> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM analytics_cohort_ltv_daily
        WHERE game_key = ? AND platform = ? AND cohort_date BETWEEN ? AND ?`,
      [gameKey, platform, fromCohortDate, toCohortDate],
    );
    if (rows.length > 0) {
      const cols = [
        'game_key',
        'cohort_date',
        'platform',
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

export async function listUserDailyRows(gameKey: string, platform = ''): Promise<UserDailyRow[]> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM analytics_user_daily
      WHERE game_key = ?
        AND (? = '' OR platform = ?)
      ORDER BY first_seen_date ASC, date_key ASC`,
    [gameKey, platform, platform],
  );
  return rows as UserDailyRow[];
}

export async function listCohortLtvRows(
  gameKey: string,
  fromCohortDate: string,
  toCohortDate: string,
  platform = '',
): Promise<CohortLtvDailyRow[]> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM analytics_cohort_ltv_daily
      WHERE game_key = ?
        AND platform = ?
        AND cohort_date BETWEEN ? AND ?
      ORDER BY cohort_date ASC, age_day ASC`,
    [gameKey, platform, fromCohortDate, toCohortDate],
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
       wechat_ad_impressions, acquisition_impressions, acquisition_activations,
       acquisition_source, note, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       spend_cny = VALUES(spend_cny),
       wechat_clicks = VALUES(wechat_clicks),
       wechat_ad_revenue_cny = VALUES(wechat_ad_revenue_cny),
       wechat_ad_impressions = VALUES(wechat_ad_impressions),
       acquisition_impressions = VALUES(acquisition_impressions),
       acquisition_activations = VALUES(acquisition_activations),
       acquisition_source = VALUES(acquisition_source),
       note = VALUES(note),
       updated_at = VALUES(updated_at)`,
    [
      input.game_key,
      input.date_key,
      input.spend_cny,
      input.wechat_clicks,
      input.wechat_ad_revenue_cny,
      input.wechat_ad_impressions,
      Math.max(0, Math.trunc(Number(input.acquisition_impressions) || 0)),
      Math.max(0, Math.trunc(Number(input.acquisition_activations) || 0)),
      input.acquisition_source || '',
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

export async function replaceWechatPublisherAdDailyRows(
  gameKey: string,
  fromDate: string,
  toDate: string,
  rows: WechatPublisherAdDailyRow[],
): Promise<number> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM wechat_publisher_ad_daily
        WHERE game_key = ? AND date_key BETWEEN ? AND ?`,
      [gameKey, fromDate, toDate],
    );
    if (rows.length > 0) {
      const cols = [
        'game_key',
        'date_key',
        'slot_id',
        'ad_slot',
        'req_succ_count',
        'exposure_count',
        'exposure_rate',
        'click_count',
        'click_rate',
        'income_cny',
        'ecpm_cny',
        'raw_json',
        'updated_at',
      ];
      const placeholders = `(${cols.map(() => '?').join(',')})`;
      const values: unknown[] = [];
      for (const row of rows) {
        for (const col of cols) values.push((row as unknown as Record<string, unknown>)[col]);
      }
      await conn.query(
        `INSERT INTO wechat_publisher_ad_daily (${cols.join(',')})
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

export async function recordWechatPublisherIngestRun(input: WechatPublisherIngestRunDraft): Promise<void> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  await pool.query(
    `INSERT INTO wechat_publisher_ingest_runs (
       trigger_source, game_key, from_date, to_date, ok, games_json,
       error_message, started_at, finished_at, duration_ms
     ) VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)`,
    [
      input.trigger_source,
      input.game_key || '',
      input.from_date,
      input.to_date,
      input.ok ? 1 : 0,
      input.games_json,
      input.error_message || '',
      input.started_at,
      input.finished_at,
      input.duration_ms,
    ],
  );
}

export async function replaceTencentAdsDailyReportRawRows(
  gameKey: string,
  accountId: string,
  reportLevel: string,
  fromDate: string,
  toDate: string,
  rows: TencentAdsDailyReportRawRow[],
): Promise<number> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM tencent_ads_daily_reports_raw
        WHERE game_key = ? AND account_id = ? AND report_level = ? AND date_key BETWEEN ? AND ?`,
      [gameKey, accountId, reportLevel, fromDate, toDate],
    );
    if (rows.length > 0) {
      const cols = [
        'game_key',
        'account_id',
        'report_level',
        'date_key',
        'adgroup_id',
        'adgroup_name',
        'cost_cny',
        'impression',
        'click',
        'activation',
        'missing_fields_json',
        'raw_json',
        'updated_at',
      ];
      const placeholders = `(${cols.map(() => '?').join(',')})`;
      const values: unknown[] = [];
      for (const row of rows) {
        for (const col of cols) values.push((row as unknown as Record<string, unknown>)[col]);
      }
      await conn.query(
        `INSERT INTO tencent_ads_daily_reports_raw (${cols.join(',')})
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

async function replaceRowsInTransaction<T extends object>(input: {
  table: string;
  deleteSql: string;
  deleteParams: unknown[];
  rows: T[];
  cols: string[];
}): Promise<number> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(input.deleteSql, input.deleteParams);
    if (input.rows.length > 0) {
      const placeholders = `(${input.cols.map(() => '?').join(',')})`;
      const values: unknown[] = [];
      for (const row of input.rows) {
        const record = row as Record<string, unknown>;
        for (const col of input.cols) values.push(record[col]);
      }
      await conn.query(
        `INSERT INTO ${input.table} (${input.cols.join(',')}) VALUES ${input.rows.map(() => placeholders).join(',')}`,
        values,
      );
    }
    await conn.commit();
    return input.rows.length;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function replaceTencentAdsTargetingTagReportRawRows(
  gameKey: string,
  accountId: string,
  reportLevel: string,
  fromDate: string,
  toDate: string,
  rows: TencentAdsTargetingTagReportRawRow[],
  dimensionTypes?: string[],
): Promise<number> {
  const dimensions = dimensionTypes && dimensionTypes.length > 0 ? dimensionTypes : [...new Set(rows.map((row) => row.dimension_type))];
  if (dimensions.length === 0) return 0;
  return replaceRowsInTransaction<TencentAdsTargetingTagReportRawRow>({
    table: 'tencent_ads_targeting_tag_reports_raw',
    deleteSql: `DELETE FROM tencent_ads_targeting_tag_reports_raw
      WHERE game_key = ? AND account_id = ? AND report_level = ? AND dimension_type IN (${dimensions.map(() => '?').join(',')}) AND date_key BETWEEN ? AND ?`,
    deleteParams: [
      gameKey,
      accountId,
      reportLevel,
      ...dimensions,
      fromDate,
      toDate,
    ],
    rows,
    cols: [
      'game_key',
      'account_id',
      'report_level',
      'date_key',
      'dimension_type',
      'dimension_value',
      'cost_cny',
      'impression',
      'click',
      'activation',
      'missing_fields_json',
      'raw_json',
      'updated_at',
    ],
  });
}

export async function replaceTencentAdsCreativeReportRawRows(
  gameKey: string,
  accountId: string,
  reportLevel: string,
  fromDate: string,
  toDate: string,
  rows: TencentAdsCreativeReportRawRow[],
): Promise<number> {
  return replaceRowsInTransaction<TencentAdsCreativeReportRawRow>({
    table: 'tencent_ads_creative_reports_raw',
    deleteSql: `DELETE FROM tencent_ads_creative_reports_raw
      WHERE game_key = ? AND account_id = ? AND report_level = ? AND date_key BETWEEN ? AND ?`,
    deleteParams: [gameKey, accountId, reportLevel, fromDate, toDate],
    rows,
    cols: [
      'game_key',
      'account_id',
      'report_level',
      'date_key',
      'adgroup_id',
      'entity_type',
      'entity_id',
      'entity_name',
      'site_set',
      'cost_cny',
      'impression',
      'click',
      'activation',
      'missing_fields_json',
      'raw_json',
      'updated_at',
    ],
  });
}

export async function replaceTencentAdsAudienceInsightRawRows(
  gameKey: string,
  accountId: string,
  rows: TencentAdsAudienceInsightRawRow[],
): Promise<number> {
  const audienceIds = [...new Set(rows.map((row) => row.audience_id))];
  const dimensionTypes = [...new Set(rows.map((row) => row.dimension_type))];
  if (audienceIds.length === 0 || dimensionTypes.length === 0) return 0;
  return replaceRowsInTransaction<TencentAdsAudienceInsightRawRow>({
    table: 'tencent_ads_audience_insights_raw',
    deleteSql: `DELETE FROM tencent_ads_audience_insights_raw
      WHERE game_key = ? AND account_id = ?
        AND audience_id IN (${audienceIds.map(() => '?').join(',')})
        AND dimension_type IN (${dimensionTypes.map(() => '?').join(',')})`,
    deleteParams: [gameKey, accountId, ...audienceIds, ...dimensionTypes],
    rows,
    cols: [
      'game_key',
      'account_id',
      'audience_id',
      'dimension_type',
      'dimension_value',
      'match_rate',
      'percentage',
      'tgi',
      'raw_json',
      'updated_at',
    ],
  });
}

export async function listTencentAdsTargetingTagReportRawRows(
  gameKey: string,
  fromDate: string,
  toDate: string,
): Promise<TencentAdsTargetingTagReportRawRow[]> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM tencent_ads_targeting_tag_reports_raw
      WHERE game_key = ? AND date_key BETWEEN ? AND ?
      ORDER BY date_key DESC, dimension_type ASC, cost_cny DESC`,
    [gameKey, fromDate, toDate],
  );
  return rows as TencentAdsTargetingTagReportRawRow[];
}

export async function listTencentAdsCreativeReportRawRows(
  gameKey: string,
  fromDate: string,
  toDate: string,
): Promise<TencentAdsCreativeReportRawRow[]> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM tencent_ads_creative_reports_raw
      WHERE game_key = ? AND date_key BETWEEN ? AND ?
      ORDER BY date_key DESC, cost_cny DESC`,
    [gameKey, fromDate, toDate],
  );
  return rows as TencentAdsCreativeReportRawRow[];
}

export async function listTencentAdsAudienceInsightRawRows(
  gameKey: string,
): Promise<TencentAdsAudienceInsightRawRow[]> {
  await ensureLtvTables();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM tencent_ads_audience_insights_raw
      WHERE game_key = ?
      ORDER BY audience_id ASC, dimension_type ASC, percentage DESC`,
    [gameKey],
  );
  return rows as TencentAdsAudienceInsightRawRow[];
}

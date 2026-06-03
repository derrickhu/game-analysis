import type mysql from 'mysql2/promise';

import { getMysqlPool, isMysqlMode } from './db';

let migrated = false;

export interface AttributionTouchpointRow {
  game_key: string;
  touch_id: string;
  event_id: string;
  user_key: string;
  user_id: string;
  anonymous_id: string;
  session_id: string;
  event_ts: number;
  provider: string;
  channel: string;
  campaign_id: string;
  adgroup_id: string;
  creative_id: string;
  click_id: string;
  gdt_vid: string;
  launch_scene: string;
  match_source: string;
  is_first_touch: number;
  raw_json: string;
  created_at: number;
  updated_at: number;
}

export interface UserAttributionRow {
  game_key: string;
  user_key: string;
  user_id: string;
  anonymous_id: string;
  first_seen_ts: number;
  attributed_at: number;
  attribution_type: string;
  match_type: string;
  confidence: number;
  provider: string;
  channel: string;
  campaign_id: string;
  adgroup_id: string;
  creative_id: string;
  click_id: string;
  gdt_vid: string;
  launch_scene: string;
  touch_id: string;
  raw_json: string;
  updated_at: number;
}

export interface AttributedUserDailyRow {
  game_key: string;
  date_key: string;
  user_key: string;
  user_id: string;
  anonymous_id: string;
  first_seen_date: string;
  is_new_user: number;
  is_active: number;
  provider: string;
  channel: string;
  campaign_id: string;
  adgroup_id: string;
  creative_id: string;
  attribution_type: string;
  match_type: string;
  confidence: number;
  session_cnt: number;
  ad_show_cnt: number;
  ad_revenue_estimated_cny: number;
  tutorial_complete_cnt: number;
  order_deliver_cnt: number;
  max_star_level: number;
  updated_at: number;
}

export interface PostbackQueueRow {
  id?: number;
  game_key: string;
  user_key: string;
  event_name: string;
  platform: string;
  platform_event_name: string;
  dedupe_key: string;
  status: 'dry_run' | 'pending' | 'sent' | 'failed';
  event_ts: number;
  payload_json: string;
  attribution_json: string;
  retry_count: number;
  last_error: string;
  created_at: number;
  updated_at: number;
}

function assertMysql(): void {
  if (!isMysqlMode()) {
    throw new Error('广告归因当前仅支持 MySQL 模式');
  }
}

async function addColumnIfMissing(pool: mysql.Pool, tableName: string, columnName: string, ddl: string): Promise<void> {
  try {
    await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${ddl}`);
  } catch (error) {
    const err = error as { code?: string };
    if (err.code !== 'ER_DUP_FIELDNAME') throw error;
  }
}

export async function initAttributionStorage(): Promise<void> {
  assertMysql();
  if (migrated) return;
  const pool = await getMysqlPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attribution_touchpoints (
      game_key VARCHAR(32) NOT NULL,
      touch_id VARCHAR(96) NOT NULL,
      event_id VARCHAR(64) NOT NULL,
      user_key VARCHAR(191) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      anonymous_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(64) NOT NULL,
      event_ts BIGINT NOT NULL,
      provider VARCHAR(64) NOT NULL,
      channel VARCHAR(64) NOT NULL,
      campaign_id VARCHAR(128) NOT NULL,
      adgroup_id VARCHAR(128) NOT NULL,
      creative_id VARCHAR(128) NOT NULL,
      click_id VARCHAR(191) NOT NULL,
      gdt_vid VARCHAR(191) NOT NULL,
      launch_scene VARCHAR(64) NOT NULL,
      match_source VARCHAR(64) NOT NULL,
      is_first_touch TINYINT NOT NULL DEFAULT 0,
      raw_json JSON NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, touch_id),
      UNIQUE KEY uniq_event (event_id),
      INDEX idx_game_ts (game_key, event_ts),
      INDEX idx_game_user (game_key, user_key, event_ts),
      INDEX idx_game_campaign (game_key, campaign_id, adgroup_id, creative_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_attribution (
      game_key VARCHAR(32) NOT NULL,
      user_key VARCHAR(191) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      anonymous_id VARCHAR(64) NOT NULL,
      first_seen_ts BIGINT NOT NULL,
      attributed_at BIGINT NOT NULL,
      attribution_type VARCHAR(32) NOT NULL,
      match_type VARCHAR(32) NOT NULL,
      confidence DOUBLE NOT NULL,
      provider VARCHAR(64) NOT NULL,
      channel VARCHAR(64) NOT NULL,
      campaign_id VARCHAR(128) NOT NULL,
      adgroup_id VARCHAR(128) NOT NULL,
      creative_id VARCHAR(128) NOT NULL,
      click_id VARCHAR(191) NOT NULL,
      gdt_vid VARCHAR(191) NOT NULL,
      launch_scene VARCHAR(64) NOT NULL,
      touch_id VARCHAR(96) NOT NULL,
      raw_json JSON NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, user_key),
      INDEX idx_game_campaign (game_key, campaign_id, adgroup_id, creative_id),
      INDEX idx_game_provider (game_key, provider, channel),
      INDEX idx_game_first_seen (game_key, first_seen_ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attributed_user_daily (
      game_key VARCHAR(32) NOT NULL,
      date_key VARCHAR(10) NOT NULL,
      user_key VARCHAR(191) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      anonymous_id VARCHAR(64) NOT NULL,
      first_seen_date VARCHAR(10) NOT NULL,
      is_new_user TINYINT NOT NULL DEFAULT 0,
      is_active TINYINT NOT NULL DEFAULT 1,
      provider VARCHAR(64) NOT NULL,
      channel VARCHAR(64) NOT NULL,
      campaign_id VARCHAR(128) NOT NULL,
      adgroup_id VARCHAR(128) NOT NULL,
      creative_id VARCHAR(128) NOT NULL,
      attribution_type VARCHAR(32) NOT NULL,
      match_type VARCHAR(32) NOT NULL,
      confidence DOUBLE NOT NULL,
      session_cnt INT NOT NULL DEFAULT 0,
      ad_show_cnt INT NOT NULL DEFAULT 0,
      ad_revenue_estimated_cny DOUBLE NOT NULL DEFAULT 0,
      tutorial_complete_cnt INT NOT NULL DEFAULT 0,
      order_deliver_cnt INT NOT NULL DEFAULT 0,
      max_star_level INT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, date_key, user_key),
      INDEX idx_game_date_campaign (game_key, date_key, campaign_id, adgroup_id, creative_id),
      INDEX idx_game_date_provider (game_key, date_key, provider, channel)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS postback_queue (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      game_key VARCHAR(32) NOT NULL,
      user_key VARCHAR(191) NOT NULL,
      event_name VARCHAR(64) NOT NULL,
      platform VARCHAR(64) NOT NULL,
      platform_event_name VARCHAR(96) NOT NULL,
      dedupe_key VARCHAR(191) NOT NULL,
      status VARCHAR(16) NOT NULL,
      event_ts BIGINT NOT NULL,
      payload_json JSON NOT NULL,
      attribution_json JSON NOT NULL,
      retry_count INT NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      UNIQUE KEY uniq_dedupe (platform, dedupe_key),
      INDEX idx_game_status (game_key, status, updated_at),
      INDEX idx_game_event (game_key, event_name, event_ts)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Forward-compatible columns for older local databases.
  await addColumnIfMissing(pool, 'postback_queue', 'attribution_json', 'JSON NOT NULL');
  migrated = true;
}

export async function upsertAttributionTouchpoints(rows: AttributionTouchpointRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await initAttributionStorage();
  const pool = await getMysqlPool();
  const cols = [
    'game_key', 'touch_id', 'event_id', 'user_key', 'user_id', 'anonymous_id', 'session_id',
    'event_ts', 'provider', 'channel', 'campaign_id', 'adgroup_id', 'creative_id',
    'click_id', 'gdt_vid', 'launch_scene', 'match_source', 'is_first_touch',
    'raw_json', 'created_at', 'updated_at',
  ];
  const placeholders = `(${cols.map(() => '?').join(',')})`;
  const updateSet = cols
    .filter((col) => col !== 'game_key' && col !== 'touch_id' && col !== 'created_at')
    .map((col) => `${col}=VALUES(${col})`)
    .join(',');
  let total = 0;
  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const values: unknown[] = [];
    for (const row of slice) {
      values.push(...cols.map((col) => (row as unknown as Record<string, unknown>)[col]));
    }
    const [result] = await pool.query(
      `INSERT INTO attribution_touchpoints (${cols.join(',')}) VALUES ${slice.map(() => placeholders).join(',')}
       ON DUPLICATE KEY UPDATE ${updateSet}`,
      values,
    );
    total += (result as mysql.ResultSetHeader).affectedRows || 0;
  }
  return total;
}

export async function upsertUserAttributions(rows: UserAttributionRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await initAttributionStorage();
  const pool = await getMysqlPool();
  const cols = [
    'game_key', 'user_key', 'user_id', 'anonymous_id', 'first_seen_ts', 'attributed_at',
    'attribution_type', 'match_type', 'confidence', 'provider', 'channel', 'campaign_id',
    'adgroup_id', 'creative_id', 'click_id', 'gdt_vid', 'launch_scene', 'touch_id',
    'raw_json', 'updated_at',
  ];
  const placeholders = `(${cols.map(() => '?').join(',')})`;
  const updateSet = cols
    .filter((col) => col !== 'game_key' && col !== 'user_key')
    .map((col) => `${col}=VALUES(${col})`)
    .join(',');
  const values: unknown[] = [];
  for (const row of rows) values.push(...cols.map((col) => (row as unknown as Record<string, unknown>)[col]));
  const [result] = await pool.query(
    `INSERT INTO user_attribution (${cols.join(',')}) VALUES ${rows.map(() => placeholders).join(',')}
     ON DUPLICATE KEY UPDATE ${updateSet}`,
    values,
  );
  return (result as mysql.ResultSetHeader).affectedRows || 0;
}

export async function replaceAttributedUserDaily(
  gameKey: string,
  fromDate: string,
  toDate: string,
  rows: AttributedUserDailyRow[],
): Promise<number> {
  await initAttributionStorage();
  const pool = await getMysqlPool();
  await pool.query(
    `DELETE FROM attributed_user_daily WHERE game_key = ? AND date_key BETWEEN ? AND ?`,
    [gameKey, fromDate, toDate],
  );
  if (rows.length === 0) return 0;
  const cols = [
    'game_key', 'date_key', 'user_key', 'user_id', 'anonymous_id', 'first_seen_date',
    'is_new_user', 'is_active', 'provider', 'channel', 'campaign_id', 'adgroup_id',
    'creative_id', 'attribution_type', 'match_type', 'confidence', 'session_cnt',
    'ad_show_cnt', 'ad_revenue_estimated_cny', 'tutorial_complete_cnt',
    'order_deliver_cnt', 'max_star_level', 'updated_at',
  ];
  const placeholders = `(${cols.map(() => '?').join(',')})`;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200);
    const values: unknown[] = [];
    for (const row of slice) values.push(...cols.map((col) => (row as unknown as Record<string, unknown>)[col]));
    const [result] = await pool.query(
      `INSERT INTO attributed_user_daily (${cols.join(',')}) VALUES ${slice.map(() => placeholders).join(',')}`,
      values,
    );
    inserted += (result as mysql.ResultSetHeader).affectedRows || 0;
  }
  return inserted;
}

export async function upsertPostbackQueue(rows: PostbackQueueRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await initAttributionStorage();
  const pool = await getMysqlPool();
  const cols = [
    'game_key', 'user_key', 'event_name', 'platform', 'platform_event_name', 'dedupe_key',
    'status', 'event_ts', 'payload_json', 'attribution_json', 'retry_count', 'last_error',
    'created_at', 'updated_at',
  ];
  const placeholders = `(${cols.map(() => '?').join(',')})`;
  const updateSet = [
    'status=VALUES(status)',
    'payload_json=VALUES(payload_json)',
    'attribution_json=VALUES(attribution_json)',
    'last_error=VALUES(last_error)',
    'updated_at=VALUES(updated_at)',
  ].join(',');
  const values: unknown[] = [];
  for (const row of rows) values.push(...cols.map((col) => (row as unknown as Record<string, unknown>)[col]));
  const [result] = await pool.query(
    `INSERT INTO postback_queue (${cols.join(',')}) VALUES ${rows.map(() => placeholders).join(',')}
     ON DUPLICATE KEY UPDATE ${updateSet}`,
    values,
  );
  return (result as mysql.ResultSetHeader).affectedRows || 0;
}

import mysql from 'mysql2/promise';

import { getConfig } from './config';

export async function createMysqlPool(): Promise<mysql.Pool | null> {
  const config = getConfig();
  if (config.storageMode !== 'mysql') return null;

  const pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: 5,
  });

  await migrateMysql(pool);
  return pool;
}

async function migrateMysql(pool: mysql.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingest_runs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      game_key VARCHAR(64) NOT NULL,
      collection_name VARCHAR(128) NOT NULL,
      status VARCHAR(24) NOT NULL,
      started_at BIGINT NOT NULL,
      finished_at BIGINT NOT NULL DEFAULT 0,
      fetched_count INT NOT NULL DEFAULT 0,
      changed_count INT NOT NULL DEFAULT 0,
      unchanged_count INT NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_latest_snapshot (
      game_key VARCHAR(64) NOT NULL,
      doc_id VARCHAR(128) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      collection_name VARCHAR(128) NOT NULL,
      platform VARCHAR(32) NOT NULL,
      updated_at BIGINT NOT NULL,
      last_write_at BIGINT NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      payload_json JSON NOT NULL,
      seen_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, doc_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS raw_snapshot_history (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      game_key VARCHAR(64) NOT NULL,
      doc_id VARCHAR(128) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      collection_name VARCHAR(128) NOT NULL,
      platform VARCHAR(32) NOT NULL,
      updated_at BIGINT NOT NULL,
      last_write_at BIGINT NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      payload_json JSON NOT NULL,
      changed_at BIGINT NOT NULL,
      INDEX idx_snapshot_history_game_changed (game_key, changed_at)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS metric_hourly (
      game_key VARCHAR(64) NOT NULL,
      metric_hour VARCHAR(16) NOT NULL,
      inferred_active_users INT NOT NULL,
      changed_snapshots INT NOT NULL,
      new_users INT NOT NULL DEFAULT 0,
      first_order_users INT NOT NULL DEFAULT 0,
      order_delta INT NOT NULL,
      merge_delta INT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, metric_hour)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS metric_daily (
      game_key VARCHAR(64) NOT NULL,
      metric_date VARCHAR(10) NOT NULL,
      users_total INT NOT NULL,
      active_users INT NOT NULL,
      avg_level DOUBLE NOT NULL,
      p50_level DOUBLE NOT NULL,
      avg_diamond DOUBLE NOT NULL,
      avg_energy DOUBLE NOT NULL,
      total_merge_count INT NOT NULL,
      total_delivered_orders INT NOT NULL,
      total_ad_entitlement_used INT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, metric_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS metric_catalog (
      metric_key VARCHAR(128) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      description TEXT NOT NULL,
      unit VARCHAR(32) NOT NULL,
      source VARCHAR(32) NOT NULL,
      precision_level VARCHAR(32) NOT NULL,
      is_common TINYINT NOT NULL
    )
  `);
}

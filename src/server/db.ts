import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import mysql from 'mysql2/promise';

import type { DailyMetric, HourlyMetric, IngestRun, PlayerFacts, RawSnapshot } from '../shared/types';
import { getConfig } from './config';

let sqliteDb: Database.Database | null = null;
let mysqlPool: mysql.Pool | null = null;

function useMysql(): boolean {
  return getConfig().storageMode === 'mysql';
}

/** 暴露给 analytics 等子模块共享存储后端选择 */
export function isMysqlMode(): boolean {
  return useMysql();
}

/** 暴露给 analytics 等子模块复用同一个 mysql 连接池，避免双连接竞争 */
export async function getMysqlPool(): Promise<mysql.Pool> {
  return getPool();
}

export function getDb(): Database.Database {
  if (sqliteDb) return sqliteDb;

  const config = getConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  sqliteDb = new Database(config.dbPath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');
  migrate(sqliteDb);
  return sqliteDb;
}

export async function initializeStorage(): Promise<void> {
  if (useMysql()) {
    await getPool();
    return;
  }
  getDb();
}

export async function closeStorage(): Promise<void> {
  if (mysqlPool) {
    await mysqlPool.end();
    mysqlPool = null;
  }
}

async function getPool(): Promise<mysql.Pool> {
  if (mysqlPool) return mysqlPool;
  const config = getConfig();
  if (!/^[a-zA-Z0-9_$]+$/.test(config.mysql.database)) {
    throw new Error(`非法 MySQL 数据库名: ${config.mysql.database}`);
  }
  const serverPool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    waitForConnections: true,
    connectionLimit: 1,
  });
  await serverPool.query(`CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await serverPool.end();

  mysqlPool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    waitForConnections: true,
    connectionLimit: 5,
    namedPlaceholders: true,
  });
  await migrateMysql(mysqlPool);
  return mysqlPool;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS raw_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_key TEXT NOT NULL,
      collection_name TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_write_at INTEGER NOT NULL,
      payload_keys_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      imported_at INTEGER NOT NULL,
      UNIQUE(game_key, doc_id)
    );

    CREATE TABLE IF NOT EXISTS player_facts (
      game_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      snapshot_updated_at INTEGER NOT NULL,
      last_write_at INTEGER NOT NULL,
      level INTEGER NOT NULL,
      star INTEGER NOT NULL,
      flower_wish INTEGER NOT NULL,
      diamond INTEGER NOT NULL,
      energy INTEGER NOT NULL,
      merge_count_total INTEGER NOT NULL,
      merge_count_today INTEGER NOT NULL,
      delivered_orders_total INTEGER NOT NULL,
      checkin_total_days INTEGER NOT NULL,
      checkin_streak_days INTEGER NOT NULL,
      quest_weekly_points INTEGER NOT NULL,
      event_points INTEGER NOT NULL,
      ad_entitlement_used_today INTEGER NOT NULL,
      tutorial_step TEXT NOT NULL,
      active_date TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY(game_key, user_id)
    );

    CREATE TABLE IF NOT EXISTS daily_metrics (
      game_key TEXT NOT NULL,
      metric_date TEXT NOT NULL,
      users_total INTEGER NOT NULL,
      active_users INTEGER NOT NULL,
      avg_level REAL NOT NULL,
      p50_level REAL NOT NULL,
      avg_diamond REAL NOT NULL,
      avg_energy REAL NOT NULL,
      total_merge_count INTEGER NOT NULL,
      total_delivered_orders INTEGER NOT NULL,
      total_ad_entitlement_used INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(game_key, metric_date)
    );

    CREATE TABLE IF NOT EXISTS raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      event_name TEXT NOT NULL,
      event_time INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      client_version TEXT NOT NULL,
      props_json TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ingest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_key TEXT NOT NULL,
      collection_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL DEFAULT 0,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      changed_count INTEGER NOT NULL DEFAULT 0,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS player_latest_snapshot (
      game_key TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      collection_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      last_write_at INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      PRIMARY KEY(game_key, doc_id)
    );

    CREATE TABLE IF NOT EXISTS raw_snapshot_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_key TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      collection_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      last_write_at INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_snapshot_history_game_changed
      ON raw_snapshot_history(game_key, changed_at);

    CREATE TABLE IF NOT EXISTS metric_hourly (
      game_key TEXT NOT NULL,
      metric_hour TEXT NOT NULL,
      inferred_active_users INTEGER NOT NULL,
      changed_snapshots INTEGER NOT NULL,
      new_users INTEGER NOT NULL DEFAULT 0,
      first_order_users INTEGER NOT NULL DEFAULT 0,
      order_delta INTEGER NOT NULL,
      merge_delta INTEGER NOT NULL,
      ad_entitlement_delta INTEGER NOT NULL DEFAULT 0,
      level_delta INTEGER NOT NULL DEFAULT 0,
      badge_delta INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(game_key, metric_hour)
    );

    CREATE TABLE IF NOT EXISTS metric_points (
      game_key TEXT NOT NULL,
      grain TEXT NOT NULL,
      bucket TEXT NOT NULL,
      metric_key TEXT NOT NULL,
      value REAL NOT NULL,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(game_key, grain, bucket, metric_key)
    );
  `);
  ensureColumn(database, 'metric_hourly', 'new_users', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'metric_hourly', 'first_order_users', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'metric_hourly', 'ad_entitlement_delta', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'metric_hourly', 'level_delta', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'metric_hourly', 'badge_delta', 'INTEGER NOT NULL DEFAULT 0');
}

function ensureColumn(
  database: Database.Database,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === columnName)) {
    database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function migrateMysql(pool: mysql.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raw_snapshots (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      game_key VARCHAR(64) NOT NULL,
      collection_name VARCHAR(128) NOT NULL,
      doc_id VARCHAR(191) NOT NULL,
      user_id VARCHAR(191) NOT NULL,
      platform VARCHAR(32) NOT NULL,
      schema_version INT NOT NULL,
      updated_at BIGINT NOT NULL,
      last_write_at BIGINT NOT NULL,
      payload_keys_json JSON NOT NULL,
      payload_json JSON NOT NULL,
      imported_at BIGINT NOT NULL,
      UNIQUE KEY uniq_raw_snapshot_game_doc (game_key, doc_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_facts (
      game_key VARCHAR(64) NOT NULL,
      user_id VARCHAR(191) NOT NULL,
      platform VARCHAR(32) NOT NULL,
      snapshot_updated_at BIGINT NOT NULL,
      last_write_at BIGINT NOT NULL,
      level INT NOT NULL,
      star INT NOT NULL,
      flower_wish INT NOT NULL,
      diamond INT NOT NULL,
      energy INT NOT NULL,
      merge_count_total INT NOT NULL,
      merge_count_today INT NOT NULL,
      delivered_orders_total INT NOT NULL,
      checkin_total_days INT NOT NULL,
      checkin_streak_days INT NOT NULL,
      quest_weekly_points INT NOT NULL,
      event_points INT NOT NULL,
      ad_entitlement_used_today INT NOT NULL,
      tutorial_step VARCHAR(128) NOT NULL,
      active_date VARCHAR(10) NOT NULL,
      raw_json JSON NOT NULL,
      PRIMARY KEY (game_key, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
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
      doc_id VARCHAR(191) NOT NULL,
      user_id VARCHAR(191) NOT NULL,
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
      doc_id VARCHAR(191) NOT NULL,
      user_id VARCHAR(191) NOT NULL,
      collection_name VARCHAR(128) NOT NULL,
      platform VARCHAR(32) NOT NULL,
      updated_at BIGINT NOT NULL,
      last_write_at BIGINT NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      payload_json JSON NOT NULL,
      changed_at BIGINT NOT NULL,
      INDEX idx_snapshot_history_game_changed (game_key, changed_at),
      INDEX idx_snapshot_history_game_user_changed (game_key, user_id, changed_at)
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
      ad_entitlement_delta INT NOT NULL DEFAULT 0,
      level_delta INT NOT NULL DEFAULT 0,
      badge_delta INT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, metric_hour)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metric_points (
      game_key VARCHAR(64) NOT NULL,
      grain VARCHAR(16) NOT NULL,
      bucket VARCHAR(32) NOT NULL,
      metric_key VARCHAR(128) NOT NULL,
      value DOUBLE NOT NULL,
      source VARCHAR(32) NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, grain, bucket, metric_key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raw_events (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      game_key VARCHAR(64) NOT NULL,
      user_id VARCHAR(191) NOT NULL,
      platform VARCHAR(32) NOT NULL,
      event_name VARCHAR(128) NOT NULL,
      event_time BIGINT NOT NULL,
      session_id VARCHAR(128) NOT NULL,
      client_version VARCHAR(64) NOT NULL,
      props_json JSON NOT NULL,
      received_at BIGINT NOT NULL
    )
  `);
  await ensureMysqlColumn(pool, 'metric_hourly', 'level_delta', 'INT NOT NULL DEFAULT 0');
  await ensureMysqlColumn(pool, 'metric_hourly', 'badge_delta', 'INT NOT NULL DEFAULT 0');
}

async function ensureMysqlColumn(
  pool: mysql.Pool,
  tableName: string,
  columnName: string,
  definitionSql: string,
): Promise<void> {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName],
  );
  if (Array.isArray(rows) && rows.length > 0) return;
  await pool.query(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definitionSql}`);
}

function hashPayload(payload: Record<string, string>): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function mapRawSnapshotRow(row: any): RawSnapshot {
  return {
    id: row.id,
    gameKey: row.game_key,
    collectionName: row.collection_name,
    docId: row.doc_id,
    userId: row.user_id,
    platform: row.platform,
    schemaVersion: Number(row.schema_version),
    updatedAt: Number(row.updated_at),
    lastWriteAt: Number(row.last_write_at),
    payloadKeys: typeof row.payload_keys_json === 'string' ? JSON.parse(row.payload_keys_json) : row.payload_keys_json,
    payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json,
    importedAt: Number(row.imported_at),
  };
}

function mapPlayerFactRow(row: any): PlayerFacts {
  return {
    gameKey: row.game_key,
    userId: row.user_id,
    platform: row.platform,
    snapshotUpdatedAt: Number(row.snapshot_updated_at),
    lastWriteAt: Number(row.last_write_at),
    level: Number(row.level),
    star: Number(row.star),
    flowerWish: Number(row.flower_wish),
    diamond: Number(row.diamond),
    energy: Number(row.energy),
    mergeCountTotal: Number(row.merge_count_total),
    mergeCountToday: Number(row.merge_count_today),
    deliveredOrdersTotal: Number(row.delivered_orders_total),
    checkinTotalDays: Number(row.checkin_total_days),
    checkinStreakDays: Number(row.checkin_streak_days),
    questWeeklyPoints: Number(row.quest_weekly_points),
    eventPoints: Number(row.event_points),
    adEntitlementUsedToday: Number(row.ad_entitlement_used_today),
    tutorialStep: row.tutorial_step,
    activeDate: row.active_date,
    raw: typeof row.raw_json === 'string' ? JSON.parse(row.raw_json || '{}') : (row.raw_json || {}),
  };
}

function mapDailyMetricRow(row: any): DailyMetric {
  return {
    gameKey: row.game_key,
    metricDate: row.metric_date,
    usersTotal: Number(row.users_total),
    activeUsers: Number(row.active_users),
    avgLevel: Number(row.avg_level),
    p50Level: Number(row.p50_level),
    avgDiamond: Number(row.avg_diamond),
    avgEnergy: Number(row.avg_energy),
    totalMergeCount: Number(row.total_merge_count),
    totalDeliveredOrders: Number(row.total_delivered_orders),
    totalAdEntitlementUsed: Number(row.total_ad_entitlement_used),
    updatedAt: Number(row.updated_at),
  };
}

function mapHourlyMetricRow(row: any): HourlyMetric {
  return {
    gameKey: row.game_key,
    metricHour: row.metric_hour,
    inferredActiveUsers: Number(row.inferred_active_users),
    changedSnapshots: Number(row.changed_snapshots),
    newUsers: Number(row.new_users),
    firstOrderUsers: Number(row.first_order_users),
    orderDelta: Number(row.order_delta),
    mergeDelta: Number(row.merge_delta),
    adEntitlementDelta: Number(row.ad_entitlement_delta ?? 0),
    levelDelta: Number(row.level_delta ?? 0),
    badgeDelta: Number(row.badge_delta ?? 0),
    updatedAt: Number(row.updated_at),
  };
}

function mapIngestRunRow(row: any): IngestRun {
  return {
    id: Number(row.id),
    gameKey: row.game_key,
    collectionName: row.collection_name,
    status: row.status,
    startedAt: Number(row.started_at),
    finishedAt: Number(row.finished_at),
    fetchedCount: Number(row.fetched_count),
    changedCount: Number(row.changed_count),
    unchangedCount: Number(row.unchanged_count),
    errorMessage: row.error_message,
  };
}

export async function upsertRawSnapshot(snapshot: RawSnapshot): Promise<void> {
  if (useMysql()) {
    const pool = await getPool();
    await pool.execute(`
      INSERT INTO raw_snapshots (
        game_key, collection_name, doc_id, user_id, platform, schema_version,
        updated_at, last_write_at, payload_keys_json, payload_json, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        collection_name = VALUES(collection_name),
        user_id = VALUES(user_id),
        platform = VALUES(platform),
        schema_version = VALUES(schema_version),
        updated_at = VALUES(updated_at),
        last_write_at = VALUES(last_write_at),
        payload_keys_json = VALUES(payload_keys_json),
        payload_json = VALUES(payload_json),
        imported_at = VALUES(imported_at)
    `, [
      snapshot.gameKey,
      snapshot.collectionName,
      snapshot.docId,
      snapshot.userId,
      snapshot.platform,
      snapshot.schemaVersion,
      snapshot.updatedAt,
      snapshot.lastWriteAt,
      JSON.stringify(snapshot.payloadKeys),
      JSON.stringify(snapshot.payload),
      snapshot.importedAt,
    ]);
    return;
  }

  getDb().prepare(`
    INSERT INTO raw_snapshots (
      game_key, collection_name, doc_id, user_id, platform, schema_version,
      updated_at, last_write_at, payload_keys_json, payload_json, imported_at
    ) VALUES (
      @gameKey, @collectionName, @docId, @userId, @platform, @schemaVersion,
      @updatedAt, @lastWriteAt, @payloadKeysJson, @payloadJson, @importedAt
    )
    ON CONFLICT(game_key, doc_id) DO UPDATE SET
      collection_name = excluded.collection_name,
      user_id = excluded.user_id,
      platform = excluded.platform,
      schema_version = excluded.schema_version,
      updated_at = excluded.updated_at,
      last_write_at = excluded.last_write_at,
      payload_keys_json = excluded.payload_keys_json,
      payload_json = excluded.payload_json,
      imported_at = excluded.imported_at
  `).run({
    ...snapshot,
    payloadKeysJson: JSON.stringify(snapshot.payloadKeys),
    payloadJson: JSON.stringify(snapshot.payload),
  });
}

export async function upsertSnapshotHistory(snapshot: RawSnapshot, seenAt = Date.now()): Promise<boolean> {
  if (useMysql()) {
    const pool = await getPool();
    const payloadJson = JSON.stringify(snapshot.payload);
    const payloadHash = hashPayload(snapshot.payload);
    const [rows] = await pool.execute(
      `SELECT payload_hash, updated_at, last_write_at
       FROM player_latest_snapshot
       WHERE game_key = ? AND doc_id = ?`,
      [snapshot.gameKey, snapshot.docId],
    );
    const existing = Array.isArray(rows) ? rows[0] as any : undefined;
    const changed = !existing
      || existing.payload_hash !== payloadHash
      || Number(existing.updated_at) !== snapshot.updatedAt
      || Number(existing.last_write_at) !== snapshot.lastWriteAt;

    if (changed) {
      await pool.execute(`
        INSERT INTO raw_snapshot_history (
          game_key, doc_id, user_id, collection_name, platform, updated_at,
          last_write_at, payload_hash, payload_json, changed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        snapshot.gameKey,
        snapshot.docId,
        snapshot.userId,
        snapshot.collectionName,
        snapshot.platform,
        snapshot.updatedAt,
        snapshot.lastWriteAt,
        payloadHash,
        payloadJson,
        seenAt,
      ]);
    }

    await pool.execute(`
      INSERT INTO player_latest_snapshot (
        game_key, doc_id, user_id, collection_name, platform, updated_at,
        last_write_at, payload_hash, payload_json, seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        collection_name = VALUES(collection_name),
        platform = VALUES(platform),
        updated_at = VALUES(updated_at),
        last_write_at = VALUES(last_write_at),
        payload_hash = VALUES(payload_hash),
        payload_json = VALUES(payload_json),
        seen_at = VALUES(seen_at)
    `, [
      snapshot.gameKey,
      snapshot.docId,
      snapshot.userId,
      snapshot.collectionName,
      snapshot.platform,
      snapshot.updatedAt,
      snapshot.lastWriteAt,
      payloadHash,
      payloadJson,
      seenAt,
    ]);

    return changed;
  }

  const database = getDb();
  const payloadJson = JSON.stringify(snapshot.payload);
  const payloadHash = hashPayload(snapshot.payload);
  const existing = database.prepare(`
    SELECT payload_hash, updated_at, last_write_at
    FROM player_latest_snapshot
    WHERE game_key = ? AND doc_id = ?
  `).get(snapshot.gameKey, snapshot.docId) as any;
  const changed = !existing
    || existing.payload_hash !== payloadHash
    || Number(existing.updated_at) !== snapshot.updatedAt
    || Number(existing.last_write_at) !== snapshot.lastWriteAt;

  if (changed) {
    database.prepare(`
      INSERT INTO raw_snapshot_history (
        game_key, doc_id, user_id, collection_name, platform, updated_at,
        last_write_at, payload_hash, payload_json, changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.gameKey,
      snapshot.docId,
      snapshot.userId,
      snapshot.collectionName,
      snapshot.platform,
      snapshot.updatedAt,
      snapshot.lastWriteAt,
      payloadHash,
      payloadJson,
      seenAt,
    );
  }

  database.prepare(`
    INSERT INTO player_latest_snapshot (
      game_key, doc_id, user_id, collection_name, platform, updated_at,
      last_write_at, payload_hash, payload_json, seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_key, doc_id) DO UPDATE SET
      user_id = excluded.user_id,
      collection_name = excluded.collection_name,
      platform = excluded.platform,
      updated_at = excluded.updated_at,
      last_write_at = excluded.last_write_at,
      payload_hash = excluded.payload_hash,
      payload_json = excluded.payload_json,
      seen_at = excluded.seen_at
  `).run(
    snapshot.gameKey,
    snapshot.docId,
    snapshot.userId,
    snapshot.collectionName,
    snapshot.platform,
    snapshot.updatedAt,
    snapshot.lastWriteAt,
    payloadHash,
    payloadJson,
    seenAt,
  );

  return changed;
}

export async function listRawSnapshots(gameKey: string): Promise<RawSnapshot[]> {
  if (useMysql()) {
    const pool = await getPool();
    const [rows] = await pool.execute(`
      SELECT * FROM raw_snapshots
      WHERE game_key = ?
      ORDER BY last_write_at DESC
    `, [gameKey]);
    return (rows as any[]).map(mapRawSnapshotRow);
  }

  const rows = getDb().prepare(`
    SELECT * FROM raw_snapshots
    WHERE game_key = ?
    ORDER BY last_write_at DESC
  `).all(gameKey) as any[];

  return rows.map(mapRawSnapshotRow);
}

export async function upsertPlayerFacts(facts: PlayerFacts): Promise<void> {
  if (useMysql()) {
    const pool = await getPool();
    await pool.execute(`
      INSERT INTO player_facts (
        game_key, user_id, platform, snapshot_updated_at, last_write_at, level,
        star, flower_wish, diamond, energy, merge_count_total, merge_count_today,
        delivered_orders_total, checkin_total_days, checkin_streak_days,
        quest_weekly_points, event_points, ad_entitlement_used_today,
        tutorial_step, active_date, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        platform = VALUES(platform),
        snapshot_updated_at = VALUES(snapshot_updated_at),
        last_write_at = VALUES(last_write_at),
        level = VALUES(level),
        star = VALUES(star),
        flower_wish = VALUES(flower_wish),
        diamond = VALUES(diamond),
        energy = VALUES(energy),
        merge_count_total = VALUES(merge_count_total),
        merge_count_today = VALUES(merge_count_today),
        delivered_orders_total = VALUES(delivered_orders_total),
        checkin_total_days = VALUES(checkin_total_days),
        checkin_streak_days = VALUES(checkin_streak_days),
        quest_weekly_points = VALUES(quest_weekly_points),
        event_points = VALUES(event_points),
        ad_entitlement_used_today = VALUES(ad_entitlement_used_today),
        tutorial_step = VALUES(tutorial_step),
        active_date = VALUES(active_date),
        raw_json = VALUES(raw_json)
    `, [
      facts.gameKey,
      facts.userId,
      facts.platform,
      facts.snapshotUpdatedAt,
      facts.lastWriteAt,
      facts.level,
      facts.star,
      facts.flowerWish,
      facts.diamond,
      facts.energy,
      facts.mergeCountTotal,
      facts.mergeCountToday,
      facts.deliveredOrdersTotal,
      facts.checkinTotalDays,
      facts.checkinStreakDays,
      facts.questWeeklyPoints,
      facts.eventPoints,
      facts.adEntitlementUsedToday,
      facts.tutorialStep,
      facts.activeDate,
      JSON.stringify(facts.raw),
    ]);
    return;
  }

  getDb().prepare(`
    INSERT INTO player_facts (
      game_key, user_id, platform, snapshot_updated_at, last_write_at, level,
      star, flower_wish, diamond, energy, merge_count_total, merge_count_today,
      delivered_orders_total, checkin_total_days, checkin_streak_days,
      quest_weekly_points, event_points, ad_entitlement_used_today,
      tutorial_step, active_date, raw_json
    ) VALUES (
      @gameKey, @userId, @platform, @snapshotUpdatedAt, @lastWriteAt, @level,
      @star, @flowerWish, @diamond, @energy, @mergeCountTotal, @mergeCountToday,
      @deliveredOrdersTotal, @checkinTotalDays, @checkinStreakDays,
      @questWeeklyPoints, @eventPoints, @adEntitlementUsedToday,
      @tutorialStep, @activeDate, @rawJson
    )
    ON CONFLICT(game_key, user_id) DO UPDATE SET
      platform = excluded.platform,
      snapshot_updated_at = excluded.snapshot_updated_at,
      last_write_at = excluded.last_write_at,
      level = excluded.level,
      star = excluded.star,
      flower_wish = excluded.flower_wish,
      diamond = excluded.diamond,
      energy = excluded.energy,
      merge_count_total = excluded.merge_count_total,
      merge_count_today = excluded.merge_count_today,
      delivered_orders_total = excluded.delivered_orders_total,
      checkin_total_days = excluded.checkin_total_days,
      checkin_streak_days = excluded.checkin_streak_days,
      quest_weekly_points = excluded.quest_weekly_points,
      event_points = excluded.event_points,
      ad_entitlement_used_today = excluded.ad_entitlement_used_today,
      tutorial_step = excluded.tutorial_step,
      active_date = excluded.active_date,
      raw_json = excluded.raw_json
  `).run({
    ...facts,
    rawJson: JSON.stringify(facts.raw),
  });
}

function dailyMetricPoints(metric: DailyMetric) {
  return [
    ['users_total', metric.usersTotal],
    ['snapshot_inferred_active', metric.activeUsers],
    ['avg_level', metric.avgLevel],
    ['avg_diamond', metric.avgDiamond],
    ['total_merges', metric.totalMergeCount],
    ['total_orders', metric.totalDeliveredOrders],
    ['ad_entitlement_used', metric.totalAdEntitlementUsed],
  ] as Array<[string, number]>;
}

function hourlyMetricPoints(metric: HourlyMetric) {
  return [
    ['snapshot_inferred_active', metric.inferredActiveUsers],
    ['new_users', metric.newUsers],
    ['first_order_users', metric.firstOrderUsers],
    ['merge_delta', metric.mergeDelta],
    ['order_delta', metric.orderDelta],
    ['ad_entitlement_delta', metric.adEntitlementDelta],
    ['level_delta', metric.levelDelta ?? 0],
    ['badge_delta', metric.badgeDelta ?? 0],
  ] as Array<[string, number]>;
}

export async function replaceDailyMetrics(gameKey: string, metrics: DailyMetric[]): Promise<void> {
  if (useMysql()) {
    const pool = await getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM daily_metrics WHERE game_key = ?', [gameKey]);
      await connection.execute('DELETE FROM metric_points WHERE game_key = ? AND grain = ?', [gameKey, 'day']);
      for (const metric of metrics) {
        await connection.execute(`
          INSERT INTO daily_metrics (
            game_key, metric_date, users_total, active_users, avg_level, p50_level,
            avg_diamond, avg_energy, total_merge_count, total_delivered_orders,
            total_ad_entitlement_used, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          metric.gameKey,
          metric.metricDate,
          metric.usersTotal,
          metric.activeUsers,
          metric.avgLevel,
          metric.p50Level,
          metric.avgDiamond,
          metric.avgEnergy,
          metric.totalMergeCount,
          metric.totalDeliveredOrders,
          metric.totalAdEntitlementUsed,
          metric.updatedAt,
        ]);
        for (const [metricKey, value] of dailyMetricPoints(metric)) {
          await connection.execute(`
            INSERT INTO metric_points (game_key, grain, bucket, metric_key, value, source, updated_at)
            VALUES (?, 'day', ?, ?, ?, 'snapshot', ?)
          `, [gameKey, metric.metricDate, metricKey, value, metric.updatedAt]);
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return;
  }

  const database = getDb();
  const insert = database.prepare(`
    INSERT INTO daily_metrics (
      game_key, metric_date, users_total, active_users, avg_level, p50_level,
      avg_diamond, avg_energy, total_merge_count, total_delivered_orders,
      total_ad_entitlement_used, updated_at
    ) VALUES (
      @gameKey, @metricDate, @usersTotal, @activeUsers, @avgLevel, @p50Level,
      @avgDiamond, @avgEnergy, @totalMergeCount, @totalDeliveredOrders,
      @totalAdEntitlementUsed, @updatedAt
    )
  `);

  database.transaction(() => {
    database.prepare('DELETE FROM daily_metrics WHERE game_key = ?').run(gameKey);
    database.prepare('DELETE FROM metric_points WHERE game_key = ? AND grain = ?').run(gameKey, 'day');
    for (const metric of metrics) insert.run(metric);
    const pointInsert = database.prepare(`
      INSERT INTO metric_points (game_key, grain, bucket, metric_key, value, source, updated_at)
      VALUES (?, 'day', ?, ?, ?, 'snapshot', ?)
    `);
    for (const metric of metrics) {
      for (const [metricKey, value] of dailyMetricPoints(metric)) {
        pointInsert.run(gameKey, metric.metricDate, metricKey, value, metric.updatedAt);
      }
    }
  })();
}

export async function replaceHourlyMetrics(gameKey: string, metrics: HourlyMetric[]): Promise<void> {
  if (useMysql()) {
    const pool = await getPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute('DELETE FROM metric_hourly WHERE game_key = ?', [gameKey]);
      await connection.execute('DELETE FROM metric_points WHERE game_key = ? AND grain = ?', [gameKey, 'hour']);
      for (const metric of metrics) {
        await connection.execute(`
          INSERT INTO metric_hourly (
            game_key, metric_hour, inferred_active_users, changed_snapshots,
            new_users, first_order_users, order_delta, merge_delta, ad_entitlement_delta,
            level_delta, badge_delta, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          metric.gameKey,
          metric.metricHour,
          metric.inferredActiveUsers,
          metric.changedSnapshots,
          metric.newUsers,
          metric.firstOrderUsers,
          metric.orderDelta,
          metric.mergeDelta,
          metric.adEntitlementDelta,
          metric.levelDelta ?? 0,
          metric.badgeDelta ?? 0,
          metric.updatedAt,
        ]);
        for (const [metricKey, value] of hourlyMetricPoints(metric)) {
          await connection.execute(`
            INSERT INTO metric_points (game_key, grain, bucket, metric_key, value, source, updated_at)
            VALUES (?, 'hour', ?, ?, ?, 'snapshot_inferred', ?)
          `, [gameKey, metric.metricHour, metricKey, value, metric.updatedAt]);
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return;
  }

  const database = getDb();
  const insert = database.prepare(`
    INSERT INTO metric_hourly (
      game_key, metric_hour, inferred_active_users, changed_snapshots,
      new_users, first_order_users, order_delta, merge_delta, ad_entitlement_delta,
      level_delta, badge_delta, updated_at
    ) VALUES (
      @gameKey, @metricHour, @inferredActiveUsers, @changedSnapshots,
      @newUsers, @firstOrderUsers, @orderDelta, @mergeDelta, @adEntitlementDelta,
      @levelDelta, @badgeDelta, @updatedAt
    )
  `);

  database.transaction(() => {
    database.prepare('DELETE FROM metric_hourly WHERE game_key = ?').run(gameKey);
    database.prepare('DELETE FROM metric_points WHERE game_key = ? AND grain = ?').run(gameKey, 'hour');
    for (const metric of metrics) insert.run(metric);
    const pointInsert = database.prepare(`
      INSERT INTO metric_points (game_key, grain, bucket, metric_key, value, source, updated_at)
      VALUES (?, 'hour', ?, ?, ?, 'snapshot_inferred', ?)
    `);
    for (const metric of metrics) {
      for (const [metricKey, value] of hourlyMetricPoints(metric)) {
        pointInsert.run(gameKey, metric.metricHour, metricKey, value, metric.updatedAt);
      }
    }
  })();
}

export async function listHourlyMetrics(gameKey: string): Promise<HourlyMetric[]> {
  if (useMysql()) {
    const pool = await getPool();
    const [rows] = await pool.execute(`
      SELECT * FROM metric_hourly
      WHERE game_key = ?
      ORDER BY metric_hour ASC
    `, [gameKey]);
    return (rows as any[]).map(mapHourlyMetricRow);
  }

  const rows = getDb().prepare(`
    SELECT * FROM metric_hourly
    WHERE game_key = ?
    ORDER BY metric_hour ASC
  `).all(gameKey) as any[];

  return rows.map(mapHourlyMetricRow);
}

export async function createIngestRun(gameKey: string, collectionName: string): Promise<number> {
  if (useMysql()) {
    const pool = await getPool();
    const [res] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO ingest_runs (
        game_key, collection_name, status, started_at, finished_at,
        fetched_count, changed_count, unchanged_count, error_message
      ) VALUES (?, ?, 'running', ?, 0, 0, 0, 0, '')`,
      [gameKey, collectionName, Date.now()],
    );
    return Number(res.insertId);
  }

  const res = getDb().prepare(`
    INSERT INTO ingest_runs (game_key, collection_name, status, started_at)
    VALUES (?, ?, 'running', ?)
  `).run(gameKey, collectionName, Date.now());
  return Number(res.lastInsertRowid);
}

export async function finishIngestRun(
  id: number,
  status: 'success' | 'failed',
  fetchedCount: number,
  changedCount: number,
  errorMessage = '',
): Promise<void> {
  if (useMysql()) {
    const pool = await getPool();
    await pool.execute(`
      UPDATE ingest_runs
      SET status = ?, finished_at = ?, fetched_count = ?, changed_count = ?,
        unchanged_count = ?, error_message = ?
      WHERE id = ?
    `, [
      status,
      Date.now(),
      fetchedCount,
      changedCount,
      Math.max(0, fetchedCount - changedCount),
      errorMessage,
      id,
    ]);
    return;
  }

  getDb().prepare(`
    UPDATE ingest_runs
    SET status = ?, finished_at = ?, fetched_count = ?, changed_count = ?,
      unchanged_count = ?, error_message = ?
    WHERE id = ?
  `).run(
    status,
    Date.now(),
    fetchedCount,
    changedCount,
    Math.max(0, fetchedCount - changedCount),
    errorMessage,
    id,
  );
}

export async function listIngestRuns(gameKey: string, limit = 20): Promise<IngestRun[]> {
  if (useMysql()) {
    const pool = await getPool();
    const safeLimit = Math.max(1, Math.floor(limit));
    const [rows] = await pool.query(`
      SELECT * FROM ingest_runs
      WHERE game_key = ?
      ORDER BY started_at DESC
      LIMIT ${safeLimit}
    `, [gameKey]);
    return (rows as any[]).map(mapIngestRunRow);
  }

  const rows = getDb().prepare(`
    SELECT * FROM ingest_runs
    WHERE game_key = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(gameKey, limit) as any[];

  return rows.map(mapIngestRunRow);
}

export async function getQualityCounts(gameKey: string) {
  if (useMysql()) {
    const pool = await getPool();
    const [[snapshotCount], [historyCount], [changedSnapshotCount]] = await Promise.all([
      pool.execute('SELECT COUNT(*) AS c FROM player_facts WHERE game_key = ?', [gameKey]),
      pool.execute('SELECT COUNT(*) AS c FROM raw_snapshot_history WHERE game_key = ?', [gameKey]),
      pool.execute('SELECT COUNT(DISTINCT user_id) AS c FROM raw_snapshot_history WHERE game_key = ?', [gameKey]),
    ]);
    return {
      snapshotCount: Number(((snapshotCount as any[])[0] as any)?.c || 0),
      historyCount: Number(((historyCount as any[])[0] as any)?.c || 0),
      changedSnapshotCount: Number(((changedSnapshotCount as any[])[0] as any)?.c || 0),
      parseFailedCount: 0,
    };
  }

  const database = getDb();
  const snapshotCount = database.prepare('SELECT COUNT(*) AS c FROM player_facts WHERE game_key = ?').get(gameKey) as any;
  const historyCount = database.prepare('SELECT COUNT(*) AS c FROM raw_snapshot_history WHERE game_key = ?').get(gameKey) as any;
  const changedSnapshotCount = database.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM raw_snapshot_history WHERE game_key = ?').get(gameKey) as any;
  return {
    snapshotCount: Number(snapshotCount?.c || 0),
    historyCount: Number(historyCount?.c || 0),
    changedSnapshotCount: Number(changedSnapshotCount?.c || 0),
    parseFailedCount: 0,
  };
}

export async function listSnapshotHistoryRows(gameKey: string): Promise<any[]> {
  if (useMysql()) {
    const pool = await getPool();
    const [rows] = await pool.execute(`
      SELECT *
      FROM raw_snapshot_history
      WHERE game_key = ?
      ORDER BY changed_at ASC
    `, [gameKey]);
    return rows as any[];
  }

  return getDb().prepare(`
    SELECT *
    FROM raw_snapshot_history
    WHERE game_key = ?
    ORDER BY changed_at ASC
  `).all(gameKey) as any[];
}

export async function listDailyMetrics(gameKey: string): Promise<DailyMetric[]> {
  if (useMysql()) {
    const pool = await getPool();
    const [rows] = await pool.execute(`
      SELECT * FROM daily_metrics
      WHERE game_key = ?
      ORDER BY metric_date ASC
    `, [gameKey]);
    return (rows as any[]).map(mapDailyMetricRow);
  }

  const rows = getDb().prepare(`
    SELECT * FROM daily_metrics
    WHERE game_key = ?
    ORDER BY metric_date ASC
  `).all(gameKey) as any[];
  return rows.map(mapDailyMetricRow);
}

export async function listPlayerFacts(gameKey: string): Promise<PlayerFacts[]> {
  if (useMysql()) {
    const pool = await getPool();
    const [rows] = await pool.execute(`
      SELECT * FROM player_facts
      WHERE game_key = ?
      ORDER BY last_write_at DESC
    `, [gameKey]);
    return (rows as any[]).map(mapPlayerFactRow);
  }

  const rows = getDb().prepare(`
    SELECT * FROM player_facts
    WHERE game_key = ?
    ORDER BY last_write_at DESC
  `).all(gameKey) as any[];
  return rows.map(mapPlayerFactRow);
}

export async function getSummaryFacts(gameKey: string) {
  if (useMysql()) {
    const pool = await getPool();
    const [rows] = await pool.execute(`
      SELECT
        COUNT(*) AS usersTotal,
        AVG(level) AS avgLevel,
        AVG(diamond) AS avgDiamond,
        SUM(merge_count_total) AS totalMergeCount,
        SUM(delivered_orders_total) AS totalDeliveredOrders
      FROM player_facts
      WHERE game_key = ?
    `, [gameKey]);
    return (rows as any[])[0] as any;
  }

  return getDb().prepare(`
    SELECT
      COUNT(*) AS usersTotal,
      AVG(level) AS avgLevel,
      AVG(diamond) AS avgDiamond,
      SUM(merge_count_total) AS totalMergeCount,
      SUM(delivered_orders_total) AS totalDeliveredOrders
    FROM player_facts
    WHERE game_key = ?
  `).get(gameKey) as any;
}

export async function countRecentWrites(gameKey: string, since: number): Promise<number> {
  if (useMysql()) {
    const pool = await getPool();
    const [rows] = await pool.execute(
      'SELECT COUNT(*) AS c FROM player_facts WHERE game_key = ? AND last_write_at >= ?',
      [gameKey, since],
    );
    return Number(((rows as any[])[0] as any)?.c || 0);
  }

  const row = getDb().prepare(`
    SELECT COUNT(*) AS c
    FROM player_facts
    WHERE game_key = ? AND last_write_at >= ?
  `).get(gameKey, since) as any;
  return Number(row?.c || 0);
}

export async function listLevelBuckets(gameKey: string) {
  if (useMysql()) {
    const pool = await getPool();
    const [rows] = await pool.execute(`
      SELECT level, COUNT(*) AS users
      FROM player_facts
      WHERE game_key = ?
      GROUP BY level
      ORDER BY level ASC
    `, [gameKey]);
    return rows as Array<{ level: number; users: number }>;
  }

  return getDb().prepare(`
    SELECT level, COUNT(*) AS users
    FROM player_facts
    WHERE game_key = ?
    GROUP BY level
    ORDER BY level ASC
  `).all(gameKey) as Array<{ level: number; users: number }>;
}

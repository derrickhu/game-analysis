import Database from 'better-sqlite3';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { getConfig } from './config';
import type { DailyMetric, HourlyMetric, IngestRun, PlayerFacts, RawSnapshot } from '../shared/types';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const config = getConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
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
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(game_key, metric_hour)
    );
  `);
  ensureColumn(database, 'metric_hourly', 'new_users', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'metric_hourly', 'first_order_users', 'INTEGER NOT NULL DEFAULT 0');
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

function hashPayload(payload: Record<string, string>): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function upsertRawSnapshot(snapshot: RawSnapshot): void {
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

export function upsertSnapshotHistory(snapshot: RawSnapshot, seenAt = Date.now()): boolean {
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

export function listRawSnapshots(gameKey: string): RawSnapshot[] {
  const rows = getDb().prepare(`
    SELECT * FROM raw_snapshots
    WHERE game_key = ?
    ORDER BY last_write_at DESC
  `).all(gameKey) as any[];

  return rows.map((row) => ({
    id: row.id,
    gameKey: row.game_key,
    collectionName: row.collection_name,
    docId: row.doc_id,
    userId: row.user_id,
    platform: row.platform,
    schemaVersion: row.schema_version,
    updatedAt: row.updated_at,
    lastWriteAt: row.last_write_at,
    payloadKeys: JSON.parse(row.payload_keys_json),
    payload: JSON.parse(row.payload_json),
    importedAt: row.imported_at,
  }));
}

export function upsertPlayerFacts(facts: PlayerFacts): void {
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

export function replaceDailyMetrics(gameKey: string, metrics: DailyMetric[]): void {
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
    for (const metric of metrics) insert.run(metric);
  })();
}

export function replaceHourlyMetrics(gameKey: string, metrics: HourlyMetric[]): void {
  const database = getDb();
  const insert = database.prepare(`
    INSERT INTO metric_hourly (
      game_key, metric_hour, inferred_active_users, changed_snapshots,
      new_users, first_order_users, order_delta, merge_delta, updated_at
    ) VALUES (
      @gameKey, @metricHour, @inferredActiveUsers, @changedSnapshots,
      @newUsers, @firstOrderUsers, @orderDelta, @mergeDelta, @updatedAt
    )
  `);

  database.transaction(() => {
    database.prepare('DELETE FROM metric_hourly WHERE game_key = ?').run(gameKey);
    for (const metric of metrics) insert.run(metric);
  })();
}

export function listHourlyMetrics(gameKey: string): HourlyMetric[] {
  const rows = getDb().prepare(`
    SELECT * FROM metric_hourly
    WHERE game_key = ?
    ORDER BY metric_hour ASC
  `).all(gameKey) as any[];

  return rows.map((row) => ({
    gameKey: row.game_key,
    metricHour: row.metric_hour,
    inferredActiveUsers: row.inferred_active_users,
    changedSnapshots: row.changed_snapshots,
    newUsers: row.new_users,
    firstOrderUsers: row.first_order_users,
    orderDelta: row.order_delta,
    mergeDelta: row.merge_delta,
    updatedAt: row.updated_at,
  }));
}

export function createIngestRun(gameKey: string, collectionName: string): number {
  const res = getDb().prepare(`
    INSERT INTO ingest_runs (game_key, collection_name, status, started_at)
    VALUES (?, ?, 'running', ?)
  `).run(gameKey, collectionName, Date.now());
  return Number(res.lastInsertRowid);
}

export function finishIngestRun(
  id: number,
  status: 'success' | 'failed',
  fetchedCount: number,
  changedCount: number,
  errorMessage = '',
): void {
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

export function listIngestRuns(gameKey: string, limit = 20): IngestRun[] {
  const rows = getDb().prepare(`
    SELECT * FROM ingest_runs
    WHERE game_key = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(gameKey, limit) as any[];

  return rows.map((row) => ({
    id: row.id,
    gameKey: row.game_key,
    collectionName: row.collection_name,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    fetchedCount: row.fetched_count,
    changedCount: row.changed_count,
    unchangedCount: row.unchanged_count,
    errorMessage: row.error_message,
  }));
}

export function getQualityCounts(gameKey: string) {
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

export function listSnapshotHistoryRows(gameKey: string): any[] {
  return getDb().prepare(`
    SELECT *
    FROM raw_snapshot_history
    WHERE game_key = ?
    ORDER BY changed_at ASC
  `).all(gameKey) as any[];
}

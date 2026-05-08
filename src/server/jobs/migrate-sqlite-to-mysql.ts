import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';

import { getConfig } from '../config';
import { getCursor } from '../analytics-db';
import { closeStorage, initializeStorage } from '../db';
import { recomputeDailyMetrics, recomputeHourlyMetrics } from '../metrics';

const config = getConfig();

function readArg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function hasColumn(database: Database.Database, tableName: string, columnName: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function hasTable(database: Database.Database, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function readGameRows(database: Database.Database, tableName: string, gameKey: string): any[] {
  if (!hasTable(database, tableName)) {
    console.warn(`跳过迁移: SQLite 中不存在表 ${tableName}`);
    return [];
  }
  return database.prepare(`SELECT * FROM ${tableName} WHERE game_key = ?`).all(gameKey);
}

function ensureJsonString(value: unknown, context: string): string | null {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  try {
    JSON.parse(text);
    return text;
  } catch {
    console.warn(`跳过非法 JSON: ${context}`);
    return null;
  }
}

async function replaceRows(
  pool: mysql.Pool,
  tableName: string,
  rows: any[],
  columns: string[],
  deleteWhere: string,
  deleteParams: unknown[],
): Promise<void> {
  const placeholders = columns.map(() => '?').join(', ');
  const updateSql = columns
    .filter((column) => column !== 'id')
    .map((column) => `\`${column}\` = VALUES(\`${column}\`)`)
    .join(', ');

  await pool.query(`DELETE FROM \`${tableName}\` ${deleteWhere}`, deleteParams);
  if (rows.length === 0) return;

  const sql = `
    INSERT INTO \`${tableName}\` (${columns.map((column) => `\`${column}\``).join(', ')})
    VALUES (${placeholders})
    ON DUPLICATE KEY UPDATE ${updateSql}
  `;
  for (const row of rows) {
    await pool.execute(sql, columns.map((column) => row[column]));
  }
}

const gameKey = readArg('game', config.defaultGameKey);
const sourcePath = readArg('source', config.dbPath);
const sqlite = new Database(sourcePath, { readonly: true });

await initializeStorage();
// analytics_* 表由 analytics-db 懒迁移创建；迁移前先触发一次，确保目标表存在。
await getCursor(gameKey);
const pool = mysql.createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
  waitForConnections: true,
  connectionLimit: 3,
});

try {
  const rawSnapshots = readGameRows(sqlite, 'raw_snapshots', gameKey);
  await replaceRows(pool, 'raw_snapshots', rawSnapshots, [
    'id',
    'game_key',
    'collection_name',
    'doc_id',
    'user_id',
    'platform',
    'schema_version',
    'updated_at',
    'last_write_at',
    'payload_keys_json',
    'payload_json',
    'imported_at',
  ], 'WHERE game_key = ?', [gameKey]);

  const latestSnapshots = readGameRows(sqlite, 'player_latest_snapshot', gameKey);
  await replaceRows(pool, 'player_latest_snapshot', latestSnapshots, [
    'game_key',
    'doc_id',
    'user_id',
    'collection_name',
    'platform',
    'updated_at',
    'last_write_at',
    'payload_hash',
    'payload_json',
    'seen_at',
  ], 'WHERE game_key = ?', [gameKey]);

  const historyRows = readGameRows(sqlite, 'raw_snapshot_history', gameKey);
  await replaceRows(pool, 'raw_snapshot_history', historyRows, [
    'id',
    'game_key',
    'doc_id',
    'user_id',
    'collection_name',
    'platform',
    'updated_at',
    'last_write_at',
    'payload_hash',
    'payload_json',
    'changed_at',
  ], 'WHERE game_key = ?', [gameKey]);

  const playerFacts = readGameRows(sqlite, 'player_facts', gameKey);
  await replaceRows(pool, 'player_facts', playerFacts, [
    'game_key',
    'user_id',
    'platform',
    'snapshot_updated_at',
    'last_write_at',
    'level',
    'star',
    'flower_wish',
    'diamond',
    'energy',
    'merge_count_total',
    'merge_count_today',
    'delivered_orders_total',
    'checkin_total_days',
    'checkin_streak_days',
    'quest_weekly_points',
    'event_points',
    'ad_entitlement_used_today',
    'tutorial_step',
    'active_date',
    'raw_json',
  ], 'WHERE game_key = ?', [gameKey]);

  const ingestRuns = readGameRows(sqlite, 'ingest_runs', gameKey);
  await replaceRows(pool, 'ingest_runs', ingestRuns, [
    'id',
    'game_key',
    'collection_name',
    'status',
    'started_at',
    'finished_at',
    'fetched_count',
    'changed_count',
    'unchanged_count',
    'error_message',
  ], 'WHERE game_key = ?', [gameKey]);

  const hourlyRows = readGameRows(sqlite, 'metric_hourly', gameKey)
    .map((row: any) => ({
      ...row,
      level_delta: hasColumn(sqlite, 'metric_hourly', 'level_delta') ? row.level_delta : 0,
      badge_delta: hasColumn(sqlite, 'metric_hourly', 'badge_delta') ? row.badge_delta : 0,
    }));
  await replaceRows(pool, 'metric_hourly', hourlyRows, [
    'game_key',
    'metric_hour',
    'inferred_active_users',
    'changed_snapshots',
    'new_users',
    'first_order_users',
    'order_delta',
    'merge_delta',
    'ad_entitlement_delta',
    'level_delta',
    'badge_delta',
    'updated_at',
  ], 'WHERE game_key = ?', [gameKey]);

  const dailyRows = readGameRows(sqlite, 'daily_metrics', gameKey);
  await replaceRows(pool, 'daily_metrics', dailyRows, [
    'game_key',
    'metric_date',
    'users_total',
    'active_users',
    'avg_level',
    'p50_level',
    'avg_diamond',
    'avg_energy',
    'total_merge_count',
    'total_delivered_orders',
    'total_ad_entitlement_used',
    'updated_at',
  ], 'WHERE game_key = ?', [gameKey]);

  const analyticsEvents = readGameRows(sqlite, 'analytics_events', gameKey)
    .map((row: any) => {
      const paramsJson = ensureJsonString(row.params_json, `analytics_events.event_id=${row.event_id}`);
      return paramsJson ? { ...row, params_json: paramsJson } : null;
    })
    .filter(Boolean) as any[];
  await replaceRows(pool, 'analytics_events', analyticsEvents, [
    'event_id',
    'event_name',
    'event_ts',
    'ingest_ts',
    'game_key',
    'app_version',
    'sdk_version',
    'platform',
    'user_id',
    'anonymous_id',
    'session_id',
    'session_seq',
    'device_brand',
    'device_model',
    'device_system',
    'device_screen_w',
    'device_screen_h',
    'device_network',
    'params_json',
    'ingested_at',
  ], 'WHERE game_key = ?', [gameKey]);

  const analyticsCursor = readGameRows(sqlite, 'analytics_cursor', gameKey);
  await replaceRows(pool, 'analytics_cursor', analyticsCursor, [
    'game_key',
    'last_event_ts',
    'last_event_id',
    'updated_at',
  ], 'WHERE game_key = ?', [gameKey]);

  const adMinuteRows = readGameRows(sqlite, 'analytics_ad_minute', gameKey);
  await replaceRows(pool, 'analytics_ad_minute', adMinuteRows, [
    'game_key',
    'minute_bucket',
    'ad_type',
    'scene',
    'ad_request_cnt',
    'ad_show_cnt',
    'ad_click_cnt',
    'ad_complete_cnt',
    'ad_error_cnt',
    'ecpm_used',
    'ad_revenue_estimated_cny',
    'updated_at',
  ], 'WHERE game_key = ?', [gameKey]);

  const analyticsIngestRuns = readGameRows(sqlite, 'analytics_ingest_runs', gameKey);
  await replaceRows(pool, 'analytics_ingest_runs', analyticsIngestRuns, [
    'id',
    'game_key',
    'started_at',
    'finished_at',
    'status',
    'fetched',
    'cursor_before',
    'cursor_after',
    'error_message',
  ], 'WHERE game_key = ?', [gameKey]);

  const dailyMetrics = await recomputeDailyMetrics(gameKey);
  const hourlyMetrics = await recomputeHourlyMetrics(gameKey);
  console.log([
    `迁移完成: game=${gameKey}`,
    `snapshots=${rawSnapshots.length}`,
    `history=${historyRows.length}`,
    `facts=${playerFacts.length}`,
    `analyticsEvents=${analyticsEvents.length}`,
    `adMinutes=${adMinuteRows.length}`,
    `analyticsRuns=${analyticsIngestRuns.length}`,
    `metricDays=${dailyMetrics.length}`,
    `metricHours=${hourlyMetrics.length}`,
  ].join(', '));
} finally {
  sqlite.close();
  await pool.end();
  await closeStorage();
}

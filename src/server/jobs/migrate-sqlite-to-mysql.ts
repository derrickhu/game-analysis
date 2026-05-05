import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';

import { getConfig } from '../config';
import { closeStorage, initializeStorage } from '../db';
import { recomputeDailyMetrics, recomputeHourlyMetrics } from '../metrics';

const config = getConfig();

if (config.storageMode !== 'mysql') {
  throw new Error('迁移到 MySQL 需要设置 GA_STORAGE=mysql');
}

function readArg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function hasColumn(database: Database.Database, tableName: string, columnName: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
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
  const rawSnapshots = sqlite.prepare('SELECT * FROM raw_snapshots WHERE game_key = ?').all(gameKey);
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

  const latestSnapshots = sqlite.prepare('SELECT * FROM player_latest_snapshot WHERE game_key = ?').all(gameKey);
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

  const historyRows = sqlite.prepare('SELECT * FROM raw_snapshot_history WHERE game_key = ?').all(gameKey);
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

  const playerFacts = sqlite.prepare('SELECT * FROM player_facts WHERE game_key = ?').all(gameKey);
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

  const ingestRuns = sqlite.prepare('SELECT * FROM ingest_runs WHERE game_key = ?').all(gameKey);
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

  const hourlyRows = sqlite.prepare('SELECT * FROM metric_hourly WHERE game_key = ?').all(gameKey)
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

  const dailyRows = sqlite.prepare('SELECT * FROM daily_metrics WHERE game_key = ?').all(gameKey);
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

  const dailyMetrics = await recomputeDailyMetrics(gameKey);
  const hourlyMetrics = await recomputeHourlyMetrics(gameKey);
  console.log(`迁移完成: game=${gameKey}, snapshots=${rawSnapshots.length}, history=${historyRows.length}, facts=${playerFacts.length}, metricDays=${dailyMetrics.length}, metricHours=${hourlyMetrics.length}`);
} finally {
  sqlite.close();
  await pool.end();
  await closeStorage();
}

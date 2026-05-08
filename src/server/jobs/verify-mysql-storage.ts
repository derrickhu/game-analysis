import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';

import { getConfig } from '../config';

const config = getConfig();

function readArg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function hasSqliteTable(database: Database.Database, tableName: string): boolean {
  const row = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function sqliteCount(database: Database.Database, tableName: string, gameKey: string): number {
  if (!hasSqliteTable(database, tableName)) return 0;
  const row = database
    .prepare(`SELECT COUNT(*) AS c FROM ${tableName} WHERE game_key = ?`)
    .get(gameKey) as { c: number };
  return Number(row?.c || 0);
}

async function mysqlCount(pool: mysql.Pool, tableName: string, gameKey: string): Promise<number> {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS c FROM \`${tableName}\` WHERE game_key = ?`,
    [gameKey],
  );
  return Number((rows as Array<{ c: number }>)[0]?.c || 0);
}

function sqliteScalar<T>(
  database: Database.Database,
  sql: string,
  args: unknown[],
  key: string,
  fallback: T,
): T {
  const row = database.prepare(sql).get(...args) as Record<string, T> | undefined;
  return row?.[key] ?? fallback;
}

async function mysqlScalar<T>(
  pool: mysql.Pool,
  sql: string,
  args: unknown[],
  key: string,
  fallback: T,
): Promise<T> {
  const [rows] = await pool.query(sql, args);
  return ((rows as Array<Record<string, T>>)[0]?.[key] ?? fallback) as T;
}

const gameKey = readArg('game', config.defaultGameKey);
const sourcePath = readArg('source', config.dbPath);
const sqlite = new Database(sourcePath, { readonly: true });
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
  const tables = [
    'analytics_events',
    'analytics_ad_minute',
    'analytics_cursor',
    'analytics_ingest_runs',
    'raw_snapshots',
    'player_facts',
    'metric_hourly',
    'daily_metrics',
  ];

  console.log(`校验 MySQL 迁移: game=${gameKey}, source=${sourcePath}`);
  for (const table of tables) {
    const source = sqliteCount(sqlite, table, gameKey);
    const target = await mysqlCount(pool, table, gameKey);
    const mark = source === target ? 'OK' : 'DIFF';
    console.log(`${mark} ${table}: sqlite=${source}, mysql=${target}`);
  }

  const sqliteEvents = sqliteCount(sqlite, 'analytics_events', gameKey);
  if (sqliteEvents > 0) {
    const sqliteNewest = sqliteScalar<number>(
      sqlite,
      'SELECT MAX(event_ts) AS v FROM analytics_events WHERE game_key = ?',
      [gameKey],
      'v',
      0,
    );
    const mysqlNewest = await mysqlScalar<number>(
      pool,
      'SELECT MAX(event_ts) AS v FROM analytics_events WHERE game_key = ?',
      [gameKey],
      'v',
      0,
    );
    console.log(`event_ts newest: sqlite=${sqliteNewest}, mysql=${mysqlNewest}`);
  }

  if (hasSqliteTable(sqlite, 'analytics_ad_minute')) {
    const sqliteShow = sqliteScalar<number>(
      sqlite,
      'SELECT COALESCE(SUM(ad_show_cnt), 0) AS v FROM analytics_ad_minute WHERE game_key = ?',
      [gameKey],
      'v',
      0,
    );
    const mysqlShow = await mysqlScalar<number>(
      pool,
      'SELECT COALESCE(SUM(ad_show_cnt), 0) AS v FROM analytics_ad_minute WHERE game_key = ?',
      [gameKey],
      'v',
      0,
    );
    const sqliteRequest = sqliteScalar<number>(
      sqlite,
      'SELECT COALESCE(SUM(ad_request_cnt), 0) AS v FROM analytics_ad_minute WHERE game_key = ?',
      [gameKey],
      'v',
      0,
    );
    const mysqlRequest = await mysqlScalar<number>(
      pool,
      'SELECT COALESCE(SUM(ad_request_cnt), 0) AS v FROM analytics_ad_minute WHERE game_key = ?',
      [gameKey],
      'v',
      0,
    );
    console.log(`ad totals: sqlite_show=${sqliteShow}, mysql_show=${mysqlShow}, sqlite_request=${sqliteRequest}, mysql_request=${mysqlRequest}`);
  }
} finally {
  sqlite.close();
  await pool.end();
}

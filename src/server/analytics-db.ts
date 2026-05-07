import type Database from 'better-sqlite3';
import type mysql from 'mysql2/promise';

import { getDb, getMysqlPool, isMysqlMode } from './db';

/**
 * Analytics 事件流相关的本地存储：events 流水表 + 拉取 cursor 表 + 分钟级广告聚合表。
 * 与 db.ts 中已有的存档差分相关表共用同一个 sqlite/mysql 连接，但 schema 完全独立，
 * 首次访问时 idempotent 建表，迁移幂等。
 */

export interface AnalyticsEventRow {
  event_id: string;
  event_name: string;
  event_ts: number;
  ingest_ts: number;
  game_key: string;
  app_version: string;
  sdk_version: string;
  platform: string;
  user_id: string;
  anonymous_id: string;
  session_id: string;
  session_seq: number;
  device_brand: string;
  device_model: string;
  device_system: string;
  device_screen_w: number;
  device_screen_h: number;
  device_network: string;
  params_json: string;
  ingested_at: number;
}

export interface AdMinuteRow {
  game_key: string;
  minute_bucket: string;
  ad_type: string;
  scene: string;
  ad_request_cnt: number;
  ad_show_cnt: number;
  ad_click_cnt: number;
  ad_complete_cnt: number;
  ad_error_cnt: number;
  ecpm_used: number;
  ad_revenue_estimated_cny: number;
  updated_at: number;
}

let migrated = false;
let migratedMysql = false;

function migrateSqlite(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      event_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      event_ts INTEGER NOT NULL,
      ingest_ts INTEGER NOT NULL,
      game_key TEXT NOT NULL,
      app_version TEXT NOT NULL,
      sdk_version TEXT NOT NULL,
      platform TEXT NOT NULL,
      user_id TEXT NOT NULL,
      anonymous_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_seq INTEGER NOT NULL,
      device_brand TEXT NOT NULL,
      device_model TEXT NOT NULL,
      device_system TEXT NOT NULL,
      device_screen_w INTEGER NOT NULL,
      device_screen_h INTEGER NOT NULL,
      device_network TEXT NOT NULL,
      params_json TEXT NOT NULL,
      ingested_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_events_game_ts
      ON analytics_events(game_key, event_ts);

    CREATE INDEX IF NOT EXISTS idx_analytics_events_game_name_ts
      ON analytics_events(game_key, event_name, event_ts);

    CREATE INDEX IF NOT EXISTS idx_analytics_events_user
      ON analytics_events(game_key, user_id, event_ts);

    CREATE TABLE IF NOT EXISTS analytics_cursor (
      game_key TEXT PRIMARY KEY,
      last_event_ts INTEGER NOT NULL,
      last_event_id TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analytics_ad_minute (
      game_key TEXT NOT NULL,
      minute_bucket TEXT NOT NULL,
      ad_type TEXT NOT NULL,
      scene TEXT NOT NULL,
      ad_request_cnt INTEGER NOT NULL DEFAULT 0,
      ad_show_cnt INTEGER NOT NULL DEFAULT 0,
      ad_click_cnt INTEGER NOT NULL DEFAULT 0,
      ad_complete_cnt INTEGER NOT NULL DEFAULT 0,
      ad_error_cnt INTEGER NOT NULL DEFAULT 0,
      ecpm_used REAL NOT NULL DEFAULT 0,
      ad_revenue_estimated_cny REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(game_key, minute_bucket, ad_type, scene)
    );

    CREATE INDEX IF NOT EXISTS idx_analytics_ad_minute_game_bucket
      ON analytics_ad_minute(game_key, minute_bucket);

    CREATE TABLE IF NOT EXISTS analytics_ingest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_key TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      fetched INTEGER NOT NULL DEFAULT 0,
      cursor_before INTEGER NOT NULL DEFAULT 0,
      cursor_after INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT ''
    );
  `);
}

async function migrateMysqlEvents(pool: mysql.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      event_id VARCHAR(64) PRIMARY KEY,
      event_name VARCHAR(64) NOT NULL,
      event_ts BIGINT NOT NULL,
      ingest_ts BIGINT NOT NULL,
      game_key VARCHAR(32) NOT NULL,
      app_version VARCHAR(32) NOT NULL,
      sdk_version VARCHAR(32) NOT NULL,
      platform VARCHAR(16) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      anonymous_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(64) NOT NULL,
      session_seq INT NOT NULL,
      device_brand VARCHAR(64) NOT NULL,
      device_model VARCHAR(128) NOT NULL,
      device_system VARCHAR(128) NOT NULL,
      device_screen_w INT NOT NULL,
      device_screen_h INT NOT NULL,
      device_network VARCHAR(32) NOT NULL,
      params_json JSON NOT NULL,
      ingested_at BIGINT NOT NULL,
      INDEX idx_game_ts (game_key, event_ts),
      INDEX idx_game_name_ts (game_key, event_name, event_ts),
      INDEX idx_user (game_key, user_id, event_ts)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_cursor (
      game_key VARCHAR(32) PRIMARY KEY,
      last_event_ts BIGINT NOT NULL,
      last_event_id VARCHAR(64) NOT NULL DEFAULT '',
      updated_at BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_ad_minute (
      game_key VARCHAR(32) NOT NULL,
      minute_bucket VARCHAR(32) NOT NULL,
      ad_type VARCHAR(32) NOT NULL,
      scene VARCHAR(64) NOT NULL,
      ad_request_cnt INT NOT NULL DEFAULT 0,
      ad_show_cnt INT NOT NULL DEFAULT 0,
      ad_click_cnt INT NOT NULL DEFAULT 0,
      ad_complete_cnt INT NOT NULL DEFAULT 0,
      ad_error_cnt INT NOT NULL DEFAULT 0,
      ecpm_used DOUBLE NOT NULL DEFAULT 0,
      ad_revenue_estimated_cny DOUBLE NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, minute_bucket, ad_type, scene),
      INDEX idx_game_bucket (game_key, minute_bucket)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_ingest_runs (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      game_key VARCHAR(32) NOT NULL,
      started_at BIGINT NOT NULL,
      finished_at BIGINT NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL,
      fetched INT NOT NULL DEFAULT 0,
      cursor_before BIGINT NOT NULL DEFAULT 0,
      cursor_after BIGINT NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL
    )
  `);
}

async function ensureMigrated(): Promise<void> {
  if (isMysqlMode()) {
    if (migratedMysql) return;
    const pool = await getMysqlPool();
    await migrateMysqlEvents(pool);
    migratedMysql = true;
  } else {
    if (migrated) return;
    migrateSqlite(getDb());
    migrated = true;
  }
}

export async function getCursor(gameKey: string): Promise<number> {
  await ensureMigrated();
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      'SELECT last_event_ts FROM analytics_cursor WHERE game_key = ?',
      [gameKey],
    );
    const list = rows as Array<{ last_event_ts: number }>;
    return list[0]?.last_event_ts ?? 0;
  }
  const row = getDb()
    .prepare('SELECT last_event_ts FROM analytics_cursor WHERE game_key = ?')
    .get(gameKey) as { last_event_ts?: number } | undefined;
  return row?.last_event_ts ?? 0;
}

export async function updateCursor(gameKey: string, lastEventTs: number, lastEventId: string): Promise<void> {
  await ensureMigrated();
  const updatedAt = Date.now();
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    await pool.query(
      `INSERT INTO analytics_cursor (game_key, last_event_ts, last_event_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE last_event_ts = VALUES(last_event_ts),
                               last_event_id = VALUES(last_event_id),
                               updated_at = VALUES(updated_at)`,
      [gameKey, lastEventTs, lastEventId, updatedAt],
    );
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO analytics_cursor (game_key, last_event_ts, last_event_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(game_key) DO UPDATE SET
         last_event_ts = excluded.last_event_ts,
         last_event_id = excluded.last_event_id,
         updated_at = excluded.updated_at`,
    )
    .run(gameKey, lastEventTs, lastEventId, updatedAt);
}

/**
 * 批量插入事件，event_id 冲突自动跳过（OR IGNORE / INSERT IGNORE）。
 * 返回实际新插入的条数（去重后）。
 */
export async function insertEvents(events: AnalyticsEventRow[]): Promise<number> {
  if (events.length === 0) return 0;
  await ensureMigrated();
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const cols = [
      'event_id', 'event_name', 'event_ts', 'ingest_ts', 'game_key',
      'app_version', 'sdk_version', 'platform', 'user_id', 'anonymous_id',
      'session_id', 'session_seq', 'device_brand', 'device_model', 'device_system',
      'device_screen_w', 'device_screen_h', 'device_network', 'params_json', 'ingested_at',
    ];
    const placeholders = `(${cols.map(() => '?').join(',')})`;
    let inserted = 0;
    // 拆批避免单条语句过大；mysql2 默认 max_allowed_packet 通常 4MB
    const CHUNK = 200;
    for (let i = 0; i < events.length; i += CHUNK) {
      const slice = events.slice(i, i + CHUNK);
      const values: unknown[] = [];
      for (const e of slice) {
        for (const c of cols) values.push((e as unknown as Record<string, unknown>)[c]);
      }
      const sql = `INSERT IGNORE INTO analytics_events (${cols.join(',')}) VALUES ${slice.map(() => placeholders).join(',')}`;
      const [result] = await pool.query(sql, values);
      const ar = result as mysql.ResultSetHeader;
      inserted += ar.affectedRows || 0;
    }
    return inserted;
  }
  const stmt = getDb().prepare(
    `INSERT OR IGNORE INTO analytics_events (
      event_id, event_name, event_ts, ingest_ts, game_key,
      app_version, sdk_version, platform, user_id, anonymous_id,
      session_id, session_seq, device_brand, device_model, device_system,
      device_screen_w, device_screen_h, device_network, params_json, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  const tx = getDb().transaction((list: AnalyticsEventRow[]) => {
    for (const e of list) {
      const info = stmt.run(
        e.event_id, e.event_name, e.event_ts, e.ingest_ts, e.game_key,
        e.app_version, e.sdk_version, e.platform, e.user_id, e.anonymous_id,
        e.session_id, e.session_seq, e.device_brand, e.device_model, e.device_system,
        e.device_screen_w, e.device_screen_h, e.device_network, e.params_json, e.ingested_at,
      );
      inserted += info.changes;
    }
  });
  tx(events);
  return inserted;
}

/** 删除超过 expireMs 毫秒的老事件，返回删除条数。给 daily cron 兜底用 */
export async function deleteOldEvents(expireMs: number): Promise<number> {
  await ensureMigrated();
  const cutoff = Date.now() - expireMs;
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [result] = await pool.query('DELETE FROM analytics_events WHERE event_ts < ?', [cutoff]);
    return (result as mysql.ResultSetHeader).affectedRows || 0;
  }
  const info = getDb().prepare('DELETE FROM analytics_events WHERE event_ts < ?').run(cutoff);
  return info.changes;
}

/** 查询单游戏分钟桶广告聚合 */
export async function listAdMinute(
  gameKey: string,
  fromMinute: string,
  toMinute: string,
): Promise<AdMinuteRow[]> {
  await ensureMigrated();
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT * FROM analytics_ad_minute
       WHERE game_key = ? AND minute_bucket >= ? AND minute_bucket <= ?
       ORDER BY minute_bucket ASC`,
      [gameKey, fromMinute, toMinute],
    );
    return rows as AdMinuteRow[];
  }
  return getDb()
    .prepare(
      `SELECT * FROM analytics_ad_minute
       WHERE game_key = ? AND minute_bucket >= ? AND minute_bucket <= ?
       ORDER BY minute_bucket ASC`,
    )
    .all(gameKey, fromMinute, toMinute) as AdMinuteRow[];
}

/** 健康度数据：统计某 game 的事件总数、24h 内事件数 */
export async function getEventStats(gameKey?: string): Promise<{
  totalEvents: number;
  last24hEvents: number;
  oldestEventTs: number | null;
  newestEventTs: number | null;
}> {
  await ensureMigrated();
  const since = Date.now() - 24 * 60 * 60 * 1000;
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const where = gameKey ? 'WHERE game_key = ?' : '';
    const args = gameKey ? [gameKey] : [];
    const [totalRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM analytics_events ${where}`, args);
    const total = (totalRows as Array<{ cnt: number }>)[0]?.cnt ?? 0;
    const [recentRows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM analytics_events ${where ? `${where} AND` : 'WHERE'} event_ts >= ?`,
      [...args, since],
    );
    const recent = (recentRows as Array<{ cnt: number }>)[0]?.cnt ?? 0;
    const [boundsRows] = await pool.query(
      `SELECT MIN(event_ts) AS oldest, MAX(event_ts) AS newest FROM analytics_events ${where}`,
      args,
    );
    const bounds = (boundsRows as Array<{ oldest: number | null; newest: number | null }>)[0];
    return {
      totalEvents: total,
      last24hEvents: recent,
      oldestEventTs: bounds?.oldest ?? null,
      newestEventTs: bounds?.newest ?? null,
    };
  }
  const db = getDb();
  const where = gameKey ? 'WHERE game_key = ?' : '';
  const args: unknown[] = gameKey ? [gameKey] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS cnt FROM analytics_events ${where}`).get(...args) as { cnt: number }).cnt;
  const recent = (db
    .prepare(`SELECT COUNT(*) AS cnt FROM analytics_events ${where ? `${where} AND` : 'WHERE'} event_ts >= ?`)
    .get(...[...args, since]) as { cnt: number }).cnt;
  const bounds = db
    .prepare(`SELECT MIN(event_ts) AS oldest, MAX(event_ts) AS newest FROM analytics_events ${where}`)
    .get(...args) as { oldest: number | null; newest: number | null };
  return {
    totalEvents: total,
    last24hEvents: recent,
    oldestEventTs: bounds?.oldest ?? null,
    newestEventTs: bounds?.newest ?? null,
  };
}

/** 记录 ingest 运行结果 */
export async function recordIngestRun(opts: {
  gameKey: string;
  startedAt: number;
  finishedAt: number;
  status: 'success' | 'failed';
  fetched: number;
  cursorBefore: number;
  cursorAfter: number;
  errorMessage?: string;
}): Promise<void> {
  await ensureMigrated();
  const errorMessage = opts.errorMessage || '';
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    await pool.query(
      `INSERT INTO analytics_ingest_runs
        (game_key, started_at, finished_at, status, fetched, cursor_before, cursor_after, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [opts.gameKey, opts.startedAt, opts.finishedAt, opts.status, opts.fetched, opts.cursorBefore, opts.cursorAfter, errorMessage],
    );
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO analytics_ingest_runs
        (game_key, started_at, finished_at, status, fetched, cursor_before, cursor_after, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.gameKey, opts.startedAt, opts.finishedAt, opts.status, opts.fetched, opts.cursorBefore, opts.cursorAfter, errorMessage);
}

/**
 * 原始事件浏览：按时间窗口 + 可选 event_name / user_id 过滤，分页返回。
 *
 * dashboard 的「原始事件」Tab 用，方便排查与二次分析。
 * 数据量预期：单次 limit ≤ 500，前端拿 JSON 渲染表格不会卡。
 */
export async function listEvents(opts: {
  gameKey: string;
  fromTs: number;
  toTs: number;
  eventName?: string;
  userQuery?: string;   // 模糊匹配 user_id / anonymous_id（任一字段包含都返回）
  limit: number;
  offset: number;
}): Promise<{ rows: AnalyticsEventRow[]; total: number }> {
  await ensureMigrated();
  const { gameKey, fromTs, toTs, eventName, userQuery, limit, offset } = opts;
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const conds = ['game_key = ?', 'event_ts BETWEEN ? AND ?'];
    const args: unknown[] = [gameKey, fromTs, toTs];
    if (eventName) {
      conds.push('event_name = ?');
      args.push(eventName);
    }
    if (userQuery) {
      conds.push('(user_id LIKE ? OR anonymous_id LIKE ?)');
      args.push(`%${userQuery}%`, `%${userQuery}%`);
    }
    const where = conds.join(' AND ');
    const [countRows] = await pool.query(`SELECT COUNT(*) AS c FROM analytics_events WHERE ${where}`, args);
    const total = Number((countRows as Array<{ c: number }>)[0]?.c || 0);
    const [rows] = await pool.query(
      `SELECT * FROM analytics_events WHERE ${where} ORDER BY event_ts DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    return { rows: rows as AnalyticsEventRow[], total };
  }
  const db = getDb();
  const conds = ['game_key = ?', 'event_ts BETWEEN ? AND ?'];
  const args: unknown[] = [gameKey, fromTs, toTs];
  if (eventName) {
    conds.push('event_name = ?');
    args.push(eventName);
  }
  if (userQuery) {
    conds.push('(user_id LIKE ? OR anonymous_id LIKE ?)');
    args.push(`%${userQuery}%`, `%${userQuery}%`);
  }
  const where = conds.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM analytics_events WHERE ${where}`).get(...args) as { c: number }).c;
  const rows = db
    .prepare(`SELECT * FROM analytics_events WHERE ${where} ORDER BY event_ts DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as AnalyticsEventRow[];
  return { rows, total };
}

/** 列出某游戏在 [fromTs,toTs] 内出现过的所有事件名，供前端事件名下拉用 */
export async function listEventNames(gameKey: string, fromTs: number, toTs: number): Promise<string[]> {
  await ensureMigrated();
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT DISTINCT event_name FROM analytics_events
        WHERE game_key = ? AND event_ts BETWEEN ? AND ?
        ORDER BY event_name ASC`,
      [gameKey, fromTs, toTs],
    );
    return (rows as Array<{ event_name: string }>).map((r) => r.event_name);
  }
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT event_name FROM analytics_events
        WHERE game_key = ? AND event_ts BETWEEN ? AND ?
        ORDER BY event_name ASC`,
    )
    .all(gameKey, fromTs, toTs) as Array<{ event_name: string }>;
  return rows.map((r) => r.event_name);
}

/** 拉取最近的 ingest 运行记录，给健康度卡片用 */
export async function listRecentIngestRuns(limit = 10): Promise<Array<{
  id: number;
  game_key: string;
  started_at: number;
  finished_at: number;
  status: string;
  fetched: number;
  cursor_before: number;
  cursor_after: number;
  error_message: string;
}>> {
  await ensureMigrated();
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      'SELECT * FROM analytics_ingest_runs ORDER BY id DESC LIMIT ?',
      [limit],
    );
    return rows as Array<any>;
  }
  return getDb()
    .prepare('SELECT * FROM analytics_ingest_runs ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<any>;
}

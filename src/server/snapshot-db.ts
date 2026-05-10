/**
 * 玩家档案快照（player snapshot）专用表的 schema 与读写 helper。
 *
 * 与事件流 analytics_events 互补：
 *   - analytics_events：玩家"做了什么"（增量、5 分钟桶）
 *   - player snapshot：玩家"现在是什么状态"（绝对值存量、每天 1 次）
 *
 * 表设计：
 *   每游戏一张 ${gameKey}_player_snapshots，按 (user_id, snapshot_date) 复合主键。
 *   每日 cron 全量扫 CloudBase 集合（如 huahua_playerData），扁平化字段后 upsert，
 *   原始 payload 不落地（避免存 JSON 大对象 + 隐私 + schema 演化复杂）。
 *   同一 user_id 同一天多次拉取覆盖最新一行；保留 30 天可看长尺度趋势。
 *
 * 通用：
 *   player_snapshot_runs 跨游戏复用（含 game_key 列），用于审计 cron 跑没跑成。
 */

import { getMysqlPool } from './db';
import { toShanghaiDateKey } from './time';

export { toShanghaiDateKey };

const ALLOWED_GAME_KEYS = new Set(['huahua', 'hotpot']);

/** 防 SQL 注入：拼接表名前必须经过白名单校验 */
function ensureGameKey(gameKey: string): void {
  if (!ALLOWED_GAME_KEYS.has(gameKey)) {
    throw new Error(`不支持的快照 gameKey: ${gameKey}`);
  }
}

/** 表名按 game_key 派生：huahua_player_snapshots / hotpot_player_snapshots */
function snapshotTable(gameKey: string): string {
  ensureGameKey(gameKey);
  return `\`${gameKey}_player_snapshots\``;
}

export interface PlayerSnapshotRow {
  user_id: string;
  snapshot_date: string;       // YYYY-MM-DD（上海时区）
  snapshot_ts: number;         // 拉取时戳 ms
  platform: string;
  last_active_at: number;
  level: number;
  star: number;
  huayuan: number;
  diamond: number;
  stamina: number;
  flower_sign_tickets: number;
  tutorial_step: number;
  tutorial_completed: 0 | 1;
  unlocked_deco_count: number;
  unlocked_room_styles_count: number;
  unlocked_outfit_count: number;
  total_merges: number;
  total_orders: number;
  checkin_total_days: number;
  checkin_streak_days: number;
  quest_weekly_points: number;
  affinity_card_owned_count: number;
  collection_discovered_count: number;
  active_customer_count: number;
}

export interface PlayerSnapshotRun {
  id: number;
  game_key: string;
  collection_name: string;
  snapshot_date: string;
  status: 'running' | 'success' | 'failed';
  started_at: number;
  finished_at: number;
  fetched_count: number;
  inserted_count: number;
  trigger_source: string;
  error_message: string | null;
}

/**
 * 启动期 ensure：建表 + 索引。
 * 跑了多次也安全（IF NOT EXISTS），改 schema 加新字段时用 ALTER TABLE ADD COLUMN。
 */
export async function initSnapshotStorage(): Promise<void> {
  const pool = await getMysqlPool();

  // 花花玩家快照：每天每用户一行，30 天后被清理 job（暂未实现，先靠 30 天数据量约束 ~30k 行可接受）
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${snapshotTable('huahua')} (
      user_id                     VARCHAR(128) NOT NULL,
      snapshot_date               VARCHAR(10)  NOT NULL,
      snapshot_ts                 BIGINT       NOT NULL,
      platform                    VARCHAR(32)  NOT NULL DEFAULT '',
      last_active_at              BIGINT       NOT NULL DEFAULT 0,
      level                       INT          NOT NULL DEFAULT 0,
      star                        BIGINT       NOT NULL DEFAULT 0,
      huayuan                     BIGINT       NOT NULL DEFAULT 0,
      diamond                     INT          NOT NULL DEFAULT 0,
      stamina                     INT          NOT NULL DEFAULT 0,
      flower_sign_tickets         INT          NOT NULL DEFAULT 0,
      tutorial_step               INT          NOT NULL DEFAULT 0,
      tutorial_completed          TINYINT(1)   NOT NULL DEFAULT 0,
      unlocked_deco_count         INT          NOT NULL DEFAULT 0,
      unlocked_room_styles_count  INT          NOT NULL DEFAULT 0,
      unlocked_outfit_count       INT          NOT NULL DEFAULT 0,
      total_merges                BIGINT       NOT NULL DEFAULT 0,
      total_orders                BIGINT       NOT NULL DEFAULT 0,
      checkin_total_days          INT          NOT NULL DEFAULT 0,
      checkin_streak_days         INT          NOT NULL DEFAULT 0,
      quest_weekly_points         INT          NOT NULL DEFAULT 0,
      affinity_card_owned_count   INT          NOT NULL DEFAULT 0,
      collection_discovered_count INT          NOT NULL DEFAULT 0,
      active_customer_count       INT          NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, snapshot_date),
      INDEX idx_date (snapshot_date),
      INDEX idx_date_level (snapshot_date, level)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );

  // 跑批审计表：跨游戏共用一张
  await pool.query(
    `CREATE TABLE IF NOT EXISTS player_snapshot_runs (
      id              BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
      game_key        VARCHAR(32) NOT NULL,
      collection_name VARCHAR(64) NOT NULL,
      snapshot_date   VARCHAR(10) NOT NULL,
      status          VARCHAR(16) NOT NULL,
      started_at      BIGINT      NOT NULL,
      finished_at     BIGINT      NOT NULL DEFAULT 0,
      fetched_count   INT         NOT NULL DEFAULT 0,
      inserted_count  INT         NOT NULL DEFAULT 0,
      trigger_source  VARCHAR(16) NOT NULL DEFAULT 'cron',
      error_message   TEXT,
      INDEX idx_game_started (game_key, started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
}

/**
 * 批量 upsert：按 (user_id, snapshot_date) 主键，存在就更新最新值。
 * 一次最多 200 行，避免单条 query 过长 / placeholder 上限 65k。
 */
export async function upsertPlayerSnapshots(
  gameKey: string,
  rows: PlayerSnapshotRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  ensureGameKey(gameKey);
  const pool = await getMysqlPool();
  const cols = [
    'user_id', 'snapshot_date', 'snapshot_ts', 'platform', 'last_active_at',
    'level', 'star', 'huayuan', 'diamond', 'stamina', 'flower_sign_tickets',
    'tutorial_step', 'tutorial_completed',
    'unlocked_deco_count', 'unlocked_room_styles_count', 'unlocked_outfit_count',
    'total_merges', 'total_orders',
    'checkin_total_days', 'checkin_streak_days', 'quest_weekly_points',
    'affinity_card_owned_count', 'collection_discovered_count', 'active_customer_count',
  ];
  const placeholderRow = `(${cols.map(() => '?').join(',')})`;

  // ON DUPLICATE KEY UPDATE：同日多次拉取（手动调试触发）覆盖为最新值
  const updateSet = cols
    .filter((c) => c !== 'user_id' && c !== 'snapshot_date')
    .map((c) => `${c}=VALUES(${c})`)
    .join(',');

  const BATCH = 200;
  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const params: any[] = [];
    for (const r of slice) {
      params.push(
        r.user_id, r.snapshot_date, r.snapshot_ts, r.platform, r.last_active_at,
        r.level, r.star, r.huayuan, r.diamond, r.stamina, r.flower_sign_tickets,
        r.tutorial_step, r.tutorial_completed,
        r.unlocked_deco_count, r.unlocked_room_styles_count, r.unlocked_outfit_count,
        r.total_merges, r.total_orders,
        r.checkin_total_days, r.checkin_streak_days, r.quest_weekly_points,
        r.affinity_card_owned_count, r.collection_discovered_count, r.active_customer_count,
      );
    }
    const sql =
      `INSERT INTO ${snapshotTable(gameKey)} (${cols.join(',')}) VALUES ` +
      slice.map(() => placeholderRow).join(',') +
      ` ON DUPLICATE KEY UPDATE ${updateSet}`;
    const [res] = await pool.query(sql, params);
    // mysql2 affectedRows：每条 insert+1 / 每条 update +2，这里只关心成功条数，按 slice.length 统计
    total += slice.length;
    void res;
  }
  return total;
}

/** 删除指定日期之前的所有快照（保留 N 天） */
export async function pruneOldSnapshots(gameKey: string, retentionDays: number): Promise<number> {
  ensureGameKey(gameKey);
  if (retentionDays <= 0 || !Number.isFinite(retentionDays)) return 0;
  const pool = await getMysqlPool();
  // 用客户端日期算 cutoff，避免 MySQL 时区差异
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.floor(retentionDays));
  const cutoffDate = toShanghaiDateKey(cutoff.getTime());
  const [res] = await pool.query(
    `DELETE FROM ${snapshotTable(gameKey)} WHERE snapshot_date < ?`,
    [cutoffDate],
  );
  return Number((res as { affectedRows?: number })?.affectedRows ?? 0);
}

// ============================================================
// run 审计
// ============================================================

export async function createSnapshotRun(
  gameKey: string,
  collectionName: string,
  snapshotDate: string,
  triggerSource: 'cron' | 'manual',
): Promise<number> {
  const pool = await getMysqlPool();
  const [res] = await pool.query(
    `INSERT INTO player_snapshot_runs
       (game_key, collection_name, snapshot_date, status, started_at, trigger_source)
     VALUES (?, ?, ?, 'running', ?, ?)`,
    [gameKey, collectionName, snapshotDate, Date.now(), triggerSource],
  );
  return Number((res as { insertId?: number })?.insertId || 0);
}

export async function finishSnapshotRun(
  id: number,
  status: 'success' | 'failed',
  fetchedCount: number,
  insertedCount: number,
  errorMessage?: string,
): Promise<void> {
  if (id <= 0) return;
  const pool = await getMysqlPool();
  await pool.query(
    `UPDATE player_snapshot_runs
        SET status = ?, finished_at = ?, fetched_count = ?, inserted_count = ?, error_message = ?
      WHERE id = ?`,
    [status, Date.now(), fetchedCount, insertedCount, errorMessage || null, id],
  );
}

export async function listRecentSnapshotRuns(gameKey?: string, limit = 10): Promise<PlayerSnapshotRun[]> {
  const pool = await getMysqlPool();
  if (gameKey) {
    ensureGameKey(gameKey);
    const [rows] = await pool.query(
      `SELECT * FROM player_snapshot_runs WHERE game_key = ? ORDER BY started_at DESC LIMIT ?`,
      [gameKey, limit],
    );
    return rows as PlayerSnapshotRun[];
  }
  const [rows] = await pool.query(
    `SELECT * FROM player_snapshot_runs ORDER BY started_at DESC LIMIT ?`,
    [limit],
  );
  return rows as PlayerSnapshotRun[];
}

/** 给前端 panel 用：取最新一次成功的 snapshot 元信息 */
export async function getLatestSnapshotMeta(
  gameKey: string,
): Promise<{ snapshot_date: string; user_count: number; latest_run?: PlayerSnapshotRun } | null> {
  ensureGameKey(gameKey);
  const pool = await getMysqlPool();
  const [dateRows] = await pool.query(
    `SELECT snapshot_date, COUNT(*) AS cnt
       FROM ${snapshotTable(gameKey)}
      GROUP BY snapshot_date
      ORDER BY snapshot_date DESC
      LIMIT 1`,
  );
  const top = (dateRows as Array<{ snapshot_date: string; cnt: number }>)[0];
  if (!top) return null;
  const runs = await listRecentSnapshotRuns(gameKey, 1);
  return {
    snapshot_date: top.snapshot_date,
    user_count: Number(top.cnt),
    latest_run: runs[0],
  };
}

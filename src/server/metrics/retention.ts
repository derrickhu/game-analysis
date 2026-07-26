import { getMysqlPool } from '../db';
import { toLocalDateKey } from './ltv';
import { PLATFORM_SQL, isPlatformFilterActive, platformSqlParams } from './platform-filter';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
const SESSION_START = 'session_start';

export type RetentionDeviceType = 'iOS' | 'Android' | 'HarmonyOS' | 'iPad' | 'Android Pad' | 'Unknown';

export interface RetentionPoint {
  age_day: number;
  retained_users: number | null;
  retention_rate: number | null;
  is_complete_day: boolean;
}

export interface RetentionSegment {
  device_type: RetentionDeviceType | '整体';
  cohort_size: number;
  points: RetentionPoint[];
}

export interface RetentionCohortResult {
  game_key: string;
  cohort_date: string;
  max_age: number;
  updated_at: number;
  notice: string;
  overall: RetentionSegment;
  devices: RetentionSegment[];
}

export interface RetentionCohortRangeResult {
  game_key: string;
  from_date: string;
  to_date: string;
  max_age: number;
  updated_at: number;
  notice: string;
  cohorts: RetentionCohortResult[];
}

interface RetentionAggregateRow {
  game_key: string;
  cohort_date: string;
  segment_type: RetentionSegment['device_type'];
  age_day: number;
  cohort_size: number;
  retained_users: number | null;
  retention_rate: number | null;
  is_complete_day: number;
  updated_at: number;
}

interface CohortUserRow {
  user_key: string;
  first_ts: number;
}

interface DeviceEventRow {
  user_key: string;
  event_ts: number;
  device_model: string;
  device_system: string;
  device_screen_w: number;
  device_screen_h: number;
}

interface ActiveEventRow {
  user_key: string;
  event_ts: number;
}

function dateKeyToStartTs(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00`).getTime();
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toLocalDateKey(d.getTime());
}

function diffDays(fromDate: string, toDate: string): number {
  return Math.floor((dateKeyToStartTs(toDate) - dateKeyToStartTs(fromDate)) / 86_400_000);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

async function ensureRetentionTable(): Promise<void> {
  const pool = await getMysqlPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analytics_cohort_retention_daily (
      game_key VARCHAR(32) NOT NULL,
      cohort_date VARCHAR(10) NOT NULL,
      segment_type VARCHAR(32) NOT NULL,
      age_day INT NOT NULL,
      cohort_size INT NOT NULL DEFAULT 0,
      retained_users INT NULL,
      retention_rate DOUBLE NULL,
      is_complete_day TINYINT NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (game_key, cohort_date, segment_type, age_day),
      INDEX idx_game_cohort_segment (game_key, cohort_date, segment_type),
      INDEX idx_game_segment_age (game_key, segment_type, age_day)
    )
  `);
}

function normalizeDeviceType(input: {
  device_model: string;
  device_system: string;
  device_screen_w: number;
  device_screen_h: number;
}): RetentionDeviceType {
  const model = String(input.device_model || '').toLowerCase();
  const system = String(input.device_system || '').toLowerCase();
  const shortSide = Math.min(Number(input.device_screen_w) || 0, Number(input.device_screen_h) || 0);

  if (model.includes('ipad') || (system.startsWith('ios') && shortSide >= 768)) return 'iPad';
  if (system.includes('harmonyos')) return 'HarmonyOS';
  if (system.startsWith('android') && shortSide >= 600) return 'Android Pad';
  if (system.startsWith('ios')) return 'iOS';
  if (system.startsWith('android')) return 'Android';
  return 'Unknown';
}

function buildSegment(
  deviceType: RetentionSegment['device_type'],
  users: Set<string>,
  retainedByUserAge: Map<string, Set<number>>,
  cohortDate: string,
  maxAge: number,
): RetentionSegment {
  const today = toLocalDateKey(Date.now());
  const points: RetentionPoint[] = [];
  for (let ageDay = 0; ageDay <= maxAge; ageDay++) {
    const targetDate = addDays(cohortDate, ageDay);
    const complete = targetDate < today;
    let retained = 0;
    if (complete) {
      for (const userKey of users) {
        if (retainedByUserAge.get(userKey)?.has(ageDay)) retained += 1;
      }
    }
    points.push({
      age_day: ageDay,
      retained_users: complete ? retained : null,
      retention_rate: complete && users.size > 0 ? round4(retained / users.size) : null,
      is_complete_day: complete,
    });
  }
  return { device_type: deviceType, cohort_size: users.size, points };
}

async function listCohortUsers(gameKey: string, cohortDate: string, platform?: string): Promise<CohortUserRow[]> {
  const pool = await getMysqlPool();
  const fromTs = dateKeyToStartTs(cohortDate);
  const toTs = dateKeyToStartTs(addDays(cohortDate, 1)) - 1;
  const platformParams = platformSqlParams(platform);
  const [rows] = await pool.query(
    `SELECT ${USER_KEY_SQL} AS user_key, MIN(event_ts) AS first_ts
       FROM analytics_events
      WHERE game_key = ?
        AND event_name = ?${PLATFORM_SQL}
      GROUP BY ${USER_KEY_SQL}
     HAVING first_ts BETWEEN ? AND ?`,
    [gameKey, SESSION_START, ...platformParams, fromTs, toTs],
  );
  return (rows as CohortUserRow[]).filter((row) => row.user_key);
}

export async function findLatestRetentionCohortDate(gameKey: string, maxAge = 7, platform?: string): Promise<string | null> {
  const pool = await getMysqlPool();
  const platformParams = platformSqlParams(platform);
  const latestCompleteDate = addDays(toLocalDateKey(Date.now()), -Math.max(1, maxAge + 1));
  const cutoffTs = dateKeyToStartTs(addDays(latestCompleteDate, 1)) - 1;
  const [completeRows] = await pool.query(
    `SELECT DATE_FORMAT(FROM_UNIXTIME(first_ts / 1000), '%Y-%m-%d') AS cohort_date, COUNT(*) AS users
       FROM (
         SELECT ${USER_KEY_SQL} AS user_key, MIN(event_ts) AS first_ts
           FROM analytics_events
          WHERE game_key = ?
            AND event_name = ?${PLATFORM_SQL}
          GROUP BY ${USER_KEY_SQL}
       ) first_seen
      WHERE first_ts <= ?
      GROUP BY cohort_date
      ORDER BY cohort_date DESC
      LIMIT 1`,
    [gameKey, SESSION_START, ...platformParams, cutoffTs],
  );
  const completeDate = (completeRows as Array<{ cohort_date: string | null }>)[0]?.cohort_date;
  if (completeDate) return completeDate;

  const d1CompleteDate = addDays(toLocalDateKey(Date.now()), -2);
  const d1CutoffTs = dateKeyToStartTs(addDays(d1CompleteDate, 1)) - 1;
  const [d1Rows] = await pool.query(
    `SELECT DATE_FORMAT(FROM_UNIXTIME(first_ts / 1000), '%Y-%m-%d') AS cohort_date, COUNT(*) AS users
       FROM (
         SELECT ${USER_KEY_SQL} AS user_key, MIN(event_ts) AS first_ts
           FROM analytics_events
          WHERE game_key = ?
            AND event_name = ?${PLATFORM_SQL}
          GROUP BY ${USER_KEY_SQL}
       ) first_seen
      WHERE first_ts <= ?
      GROUP BY cohort_date
      ORDER BY cohort_date DESC
      LIMIT 1`,
    [gameKey, SESSION_START, ...platformParams, d1CutoffTs],
  );
  const d1Date = (d1Rows as Array<{ cohort_date: string | null }>)[0]?.cohort_date;
  if (d1Date) return d1Date;

  const yesterdayCutoffTs = dateKeyToStartTs(toLocalDateKey(Date.now())) - 1;
  const [latestRows] = await pool.query(
    `SELECT DATE_FORMAT(FROM_UNIXTIME(first_ts / 1000), '%Y-%m-%d') AS cohort_date, COUNT(*) AS users
       FROM (
         SELECT ${USER_KEY_SQL} AS user_key, MIN(event_ts) AS first_ts
           FROM analytics_events
          WHERE game_key = ?
            AND event_name = ?${PLATFORM_SQL}
          GROUP BY ${USER_KEY_SQL}
       ) first_seen
      WHERE first_ts <= ?
      GROUP BY cohort_date
      ORDER BY cohort_date DESC
      LIMIT 1`,
    [gameKey, SESSION_START, ...platformParams, yesterdayCutoffTs],
  );
  return (latestRows as Array<{ cohort_date: string | null }>)[0]?.cohort_date || null;
}

async function queryByUserBatches<T>(
  gameKey: string,
  userKeys: string[],
  buildSql: (placeholders: string) => string,
  params: (batch: string[]) => unknown[],
): Promise<T[]> {
  const pool = await getMysqlPool();
  const out: T[] = [];
  const batchSize = 800;
  for (let i = 0; i < userKeys.length; i += batchSize) {
    const batch = userKeys.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    const [rows] = await pool.query(buildSql(placeholders), [gameKey, ...params(batch)]);
    out.push(...(rows as T[]));
  }
  return out;
}

async function listFirstDeviceEvents(
  gameKey: string,
  cohortDate: string,
  userKeys: string[],
  platform?: string,
): Promise<DeviceEventRow[]> {
  const fromTs = dateKeyToStartTs(cohortDate);
  const toTs = dateKeyToStartTs(addDays(cohortDate, 1)) - 1;
  const platformParams = platformSqlParams(platform);
  return queryByUserBatches<DeviceEventRow>(
    gameKey,
    userKeys,
    (placeholders) =>
      `SELECT ${USER_KEY_SQL} AS user_key, event_ts, device_model, device_system, device_screen_w, device_screen_h
         FROM analytics_events
        WHERE game_key = ?
          AND ${USER_KEY_SQL} IN (${placeholders})
          AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}
        ORDER BY event_ts ASC`,
    (batch) => [...batch, fromTs, toTs, ...platformParams],
  );
}

async function listActiveEvents(
  gameKey: string,
  cohortDate: string,
  maxAge: number,
  userKeys: string[],
  platform?: string,
): Promise<ActiveEventRow[]> {
  const fromTs = dateKeyToStartTs(cohortDate);
  const toTs = dateKeyToStartTs(addDays(cohortDate, maxAge + 1)) - 1;
  const platformParams = platformSqlParams(platform);
  return queryByUserBatches<ActiveEventRow>(
    gameKey,
    userKeys,
    (placeholders) =>
      `SELECT ${USER_KEY_SQL} AS user_key, event_ts
         FROM analytics_events
        WHERE game_key = ?
          AND ${USER_KEY_SQL} IN (${placeholders})
          AND event_name = ?
          AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`,
    (batch) => [...batch, SESSION_START, fromTs, toTs, ...platformParams],
  );
}

export async function getRetentionCohortOverview(
  gameKey: string,
  cohortDate: string,
  options: { maxAge?: number; platform?: string } = {},
): Promise<RetentionCohortResult> {
  const maxAge = Math.max(1, Math.min(30, Number(options.maxAge) || 30));
  const platform = options.platform;
  const cohortUsers = await listCohortUsers(gameKey, cohortDate, platform);
  const userKeys = cohortUsers.map((row) => row.user_key);
  const allUsers = new Set(userKeys);
  if (userKeys.length === 0) {
    return {
      game_key: gameKey,
      cohort_date: cohortDate,
      max_age: maxAge,
      updated_at: Date.now(),
      notice: '留存为 cohort 口径，按首次 session_start 日期分组；D7/D30 未完整结束前不展示成熟值。',
      overall: { device_type: '整体', cohort_size: 0, points: buildSegment('整体', new Set(), new Map(), cohortDate, maxAge).points },
      devices: [],
    };
  }

  const [deviceEvents, activeEvents] = await Promise.all([
    listFirstDeviceEvents(gameKey, cohortDate, userKeys, platform),
    listActiveEvents(gameKey, cohortDate, maxAge, userKeys, platform),
  ]);

  const deviceByUser = new Map<string, RetentionDeviceType>();
  for (const row of deviceEvents) {
    if (deviceByUser.has(row.user_key)) continue;
    deviceByUser.set(row.user_key, normalizeDeviceType(row));
  }

  const usersByDevice = new Map<RetentionDeviceType, Set<string>>();
  for (const userKey of userKeys) {
    const deviceType = deviceByUser.get(userKey) || 'Unknown';
    const set = usersByDevice.get(deviceType) || new Set<string>();
    set.add(userKey);
    usersByDevice.set(deviceType, set);
  }

  const retainedByUserAge = new Map<string, Set<number>>();
  for (const row of activeEvents) {
    const ageDay = diffDays(cohortDate, toLocalDateKey(Number(row.event_ts)));
    if (ageDay < 0 || ageDay > maxAge) continue;
    const set = retainedByUserAge.get(row.user_key) || new Set<number>();
    set.add(ageDay);
    retainedByUserAge.set(row.user_key, set);
  }

  return {
    game_key: gameKey,
    cohort_date: cohortDate,
    max_age: maxAge,
    updated_at: Date.now(),
    notice: '留存为 cohort 口径，按首次 session_start 日期分组；D7/D30 未完整结束前不展示成熟值。',
    overall: buildSegment('整体', allUsers, retainedByUserAge, cohortDate, maxAge),
    devices: Array.from(usersByDevice.entries())
      .map(([deviceType, users]) => buildSegment(deviceType, users, retainedByUserAge, cohortDate, maxAge))
      .sort((a, b) => b.cohort_size - a.cohort_size),
  };
}

async function replaceRetentionRows(
  gameKey: string,
  fromDate: string,
  toDate: string,
  rows: RetentionAggregateRow[],
): Promise<number> {
  await ensureRetentionTable();
  const pool = await getMysqlPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM analytics_cohort_retention_daily
        WHERE game_key = ? AND cohort_date BETWEEN ? AND ?`,
      [gameKey, fromDate, toDate],
    );
    if (rows.length > 0) {
      const cols = [
        'game_key',
        'cohort_date',
        'segment_type',
        'age_day',
        'cohort_size',
        'retained_users',
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
        `INSERT INTO analytics_cohort_retention_daily (${cols.join(',')})
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

async function listRetentionRows(
  gameKey: string,
  fromDate: string,
  toDate: string,
  maxAge: number,
): Promise<RetentionAggregateRow[]> {
  await ensureRetentionTable();
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT * FROM analytics_cohort_retention_daily
      WHERE game_key = ?
        AND cohort_date BETWEEN ? AND ?
        AND age_day <= ?
      ORDER BY cohort_date ASC, segment_type ASC, age_day ASC`,
    [gameKey, fromDate, toDate, maxAge],
  );
  return rows as RetentionAggregateRow[];
}

function flattenCohort(result: RetentionCohortResult): RetentionAggregateRow[] {
  const now = Date.now();
  const segments = [result.overall, ...result.devices];
  const rows: RetentionAggregateRow[] = [];
  for (const segment of segments) {
    for (const point of segment.points) {
      rows.push({
        game_key: result.game_key,
        cohort_date: result.cohort_date,
        segment_type: segment.device_type,
        age_day: point.age_day,
        cohort_size: segment.cohort_size,
        retained_users: point.retained_users,
        retention_rate: point.retention_rate,
        is_complete_day: point.is_complete_day ? 1 : 0,
        updated_at: now,
      });
    }
  }
  return rows;
}

function buildCohortsFromRows(
  gameKey: string,
  rows: RetentionAggregateRow[],
  maxAge: number,
): RetentionCohortResult[] {
  const byCohort = new Map<string, RetentionAggregateRow[]>();
  for (const row of rows) {
    const list = byCohort.get(row.cohort_date) || [];
    list.push(row);
    byCohort.set(row.cohort_date, list);
  }

  const buildSegmentFromRows = (
    segmentType: RetentionSegment['device_type'],
    segmentRows: RetentionAggregateRow[],
  ): RetentionSegment => {
    const byAge = new Map(segmentRows.map((row) => [Number(row.age_day), row]));
    const cohortSize = Number(segmentRows[0]?.cohort_size || 0);
    const points: RetentionPoint[] = [];
    for (let ageDay = 0; ageDay <= maxAge; ageDay++) {
      const row = byAge.get(ageDay);
      points.push({
        age_day: ageDay,
        retained_users: row ? (row.retained_users === null ? null : Number(row.retained_users)) : null,
        retention_rate: row ? (row.retention_rate === null ? null : Number(row.retention_rate)) : null,
        is_complete_day: row ? Number(row.is_complete_day) === 1 : false,
      });
    }
    return { device_type: segmentType, cohort_size: cohortSize, points };
  };

  return Array.from(byCohort.entries()).map(([cohortDate, cohortRows]) => {
    const bySegment = new Map<RetentionSegment['device_type'], RetentionAggregateRow[]>();
    for (const row of cohortRows) {
      const segmentType = row.segment_type;
      const list = bySegment.get(segmentType) || [];
      list.push(row);
      bySegment.set(segmentType, list);
    }
    const overall = buildSegmentFromRows('整体', bySegment.get('整体') || []);
    const devices = Array.from(bySegment.entries())
      .filter(([segmentType]) => segmentType !== '整体')
      .map(([segmentType, segmentRows]) => buildSegmentFromRows(segmentType, segmentRows))
      .sort((a, b) => b.cohort_size - a.cohort_size);
    return {
      game_key: gameKey,
      cohort_date: cohortDate,
      max_age: maxAge,
      updated_at: Math.max(...cohortRows.map((row) => Number(row.updated_at || 0))),
      notice: '留存为 cohort 口径，按首次 session_start 日期分组；D7/D30 未完整结束前不展示成熟值。',
      overall,
      devices,
    };
  });
}

async function listCohortDatesInRange(gameKey: string, fromDate: string, toDate: string, platform?: string): Promise<string[]> {
  const pool = await getMysqlPool();
  const fromTs = dateKeyToStartTs(fromDate);
  const toTs = dateKeyToStartTs(addDays(toDate, 1)) - 1;
  const platformParams = platformSqlParams(platform);
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(FROM_UNIXTIME(first_ts / 1000), '%Y-%m-%d') AS cohort_date, COUNT(*) AS users
       FROM (
         SELECT ${USER_KEY_SQL} AS user_key, MIN(event_ts) AS first_ts
           FROM analytics_events
          WHERE game_key = ?
            AND event_name = ?${PLATFORM_SQL}
          GROUP BY ${USER_KEY_SQL}
       ) first_seen
      WHERE first_ts BETWEEN ? AND ?
      GROUP BY cohort_date
      ORDER BY cohort_date ASC`,
    [gameKey, SESSION_START, ...platformParams, fromTs, toTs],
  );
  return (rows as Array<{ cohort_date: string | null }>).map((row) => row.cohort_date).filter(Boolean) as string[];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    out.push(...(await Promise.all(batch.map(mapper))));
  }
  return out;
}

export async function getRetentionCohortRangeOverview(
  gameKey: string,
  fromDate: string,
  toDate: string,
  options: { maxAge?: number; platform?: string } = {},
): Promise<RetentionCohortRangeResult> {
  const maxAge = Math.max(1, Math.min(30, Number(options.maxAge) || 30));
  const platform = options.platform;

  // 预聚合表 analytics_cohort_retention_daily 不区分平台；选定具体平台时改为对范围内每个
  // cohort 日期实时调用 getRetentionCohortOverview 并汇总，不落库。
  if (isPlatformFilterActive(platform)) {
    const cohortDates = await listCohortDatesInRange(gameKey, fromDate, toDate, platform);
    const cohorts = await mapWithConcurrency(cohortDates, 4, (cohortDate) =>
      getRetentionCohortOverview(gameKey, cohortDate, { maxAge, platform }),
    );
    return {
      game_key: gameKey,
      from_date: fromDate,
      to_date: toDate,
      max_age: maxAge,
      updated_at: Date.now(),
      notice: '留存为 cohort 口径，按首次 session_start 日期分组；D7/D30 未完整结束前不展示成熟值。已按平台实时重算，未落库。',
      cohorts,
    };
  }

  const rows = await listRetentionRows(gameKey, fromDate, toDate, maxAge);
  const cohorts = buildCohortsFromRows(gameKey, rows, maxAge);
  return {
    game_key: gameKey,
    from_date: fromDate,
    to_date: toDate,
    max_age: maxAge,
    updated_at: Date.now(),
    notice: '留存为 cohort 口径，按首次 session_start 日期分组；D7/D30 未完整结束前不展示成熟值。',
    cohorts,
  };
}

export async function getPrecomputedRetentionCohortOverview(
  gameKey: string,
  cohortDate: string,
  options: { maxAge?: number } = {},
): Promise<RetentionCohortResult> {
  const maxAge = Math.max(1, Math.min(30, Number(options.maxAge) || 30));
  const rows = await listRetentionRows(gameKey, cohortDate, cohortDate, maxAge);
  const cohort = buildCohortsFromRows(gameKey, rows, maxAge)[0];
  if (cohort) return cohort;
  return {
    game_key: gameKey,
    cohort_date: cohortDate,
    max_age: maxAge,
    updated_at: Date.now(),
    notice: '留存为 cohort 口径，按首次 session_start 日期分组；当前聚合表暂无该日期数据，等待下一次留存回算。',
    overall: { device_type: '整体', cohort_size: 0, points: buildSegment('整体', new Set(), new Map(), cohortDate, maxAge).points },
    devices: [],
  };
}

export async function recomputeRetentionCohorts(
  gameKey: string,
  options: { fromDate?: string; toDate?: string; maxAge?: number } = {},
): Promise<{ game_key: string; from_date: string; to_date: string; rows: number }> {
  const maxAge = Math.max(1, Math.min(30, Number(options.maxAge) || 30));
  const today = toLocalDateKey(Date.now());
  const toDate = options.toDate || addDays(today, -1);
  const fromDate = options.fromDate || addDays(toDate, -30);
  const cohortDates = await listCohortDatesInRange(gameKey, fromDate, toDate);
  const cohorts = await mapWithConcurrency(cohortDates, 4, (cohortDate) =>
    getRetentionCohortOverview(gameKey, cohortDate, { maxAge }),
  );
  const rows = cohorts.flatMap(flattenCohort);
  const inserted = await replaceRetentionRows(gameKey, fromDate, toDate, rows);
  return { game_key: gameKey, from_date: fromDate, to_date: toDate, rows: inserted };
}

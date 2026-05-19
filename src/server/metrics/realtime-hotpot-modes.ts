import { getDb, getMysqlPool, isMysqlMode } from '../db';
import { BUCKET_SIZE_MS, bucketToTs, tsToBucket } from './bucket';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";

const FRUIT_SLICE_EVENTS = [
  'fruit_slice_start',
  'fruit_slice_end',
  'fruit_slice_tool_use',
  'fruit_slice_revive',
  'fruit_slice_checkpoint_start',
  'fruit_slice_milestone',
] as const;

const DAILY_LIMITED_EVENTS = [
  'daily_limited_start',
  'daily_limited_end',
  'daily_limited_tool_use',
  'daily_limited_buffer_unlock',
  'daily_limited_recipe_share',
] as const;

interface AnalyticsRow {
  event_name: string;
  event_ts: number;
  uk: string;
  params_json: unknown;
}

export interface HotpotFruitSliceOverview {
  kpi: {
    total_starts: number;
    total_ends: number;
    start_users: number;
    avg_score: number;
    avg_duration_ms: number;
    avg_match_count: number;
    revive_count: number;
    checkpoint_start_count: number;
    tool_use_count: number;
    milestone_count: number;
    computed_at: number;
  };
  series: Array<{
    bucket: string;
    ts: number;
    start_cnt: number;
    end_cnt: number;
    revive_cnt: number;
    tool_cnt: number;
  }>;
  fail_reasons: Array<{ reason: string; count: number }>;
  start_sources: Array<{ source: string; count: number }>;
  tool_usage: Array<{ tool_kind: string; count: number }>;
  score_buckets: Array<{ bucket: string; count: number }>;
}

export interface HotpotDailyLimitedOverview {
  kpi: {
    total_starts: number;
    total_ends: number;
    start_users: number;
    success_count: number;
    fail_count: number;
    success_rate: number | null;
    avg_duration_ms: number;
    avg_card_clicks: number;
    avg_collected_count: number;
    buffer_unlock_count: number;
    buffer_unlock_users: number;
    ended_with_unlock_count: number;
    share_count: number;
    tool_use_count: number;
    computed_at: number;
  };
  series: Array<{
    bucket: string;
    ts: number;
    start_cnt: number;
    success_cnt: number;
    fail_cnt: number;
    tool_cnt: number;
  }>;
  end_reasons: Array<{ reason: string; count: number }>;
  level_distribution: Array<{
    level_id: number;
    theme_id: string;
    drink_name: string;
    starts: number;
    success: number;
    fails: number;
    success_rate: number | null;
  }>;
  tool_usage: Array<{ tool_kind: string; count: number }>;
}

export async function getHotpotFruitSliceOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HotpotFruitSliceOverview> {
  const rows = await listModeRows(gameKey, FRUIT_SLICE_EVENTS, fromTs, toTs);
  const starts = rows.filter((r) => r.event_name === 'fruit_slice_start');
  const ends = rows.filter((r) => r.event_name === 'fruit_slice_end');
  const startUsers = new Set(starts.map((r) => r.uk));
  const scores = ends.map((r) => numParam(r, 'score')).filter((v) => v > 0);
  const durations = ends.map((r) => numParam(r, 'duration_ms')).filter((v) => v > 0);
  const matchCounts = ends.map((r) => numParam(r, 'match_count')).filter((v) => v > 0);
  const series = buildFruitSliceSeries(rows, fromTs, toTs);

  return {
    kpi: {
      total_starts: starts.length,
      total_ends: ends.length,
      start_users: startUsers.size,
      avg_score: avg(scores),
      avg_duration_ms: avg(durations),
      avg_match_count: avg(matchCounts),
      revive_count: rows.filter((r) => r.event_name === 'fruit_slice_revive').length,
      checkpoint_start_count: rows.filter((r) => r.event_name === 'fruit_slice_checkpoint_start').length,
      tool_use_count: rows.filter((r) => r.event_name === 'fruit_slice_tool_use').length,
      milestone_count: rows.filter((r) => r.event_name === 'fruit_slice_milestone').length,
      computed_at: Date.now(),
    },
    series,
    fail_reasons: countStringParam(ends, 'fail_reason', 'unknown', 'reason'),
    start_sources: countStringParam(starts, 'start_source', 'unknown', 'source'),
    tool_usage: countStringParam(rows.filter((r) => r.event_name === 'fruit_slice_tool_use'), 'tool_kind', 'unknown', 'tool_kind'),
    score_buckets: buildScoreBuckets(scores),
  };
}

export async function getHotpotDailyLimitedOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<HotpotDailyLimitedOverview> {
  const rows = await listModeRows(gameKey, DAILY_LIMITED_EVENTS, fromTs, toTs);
  const starts = rows.filter((r) => r.event_name === 'daily_limited_start');
  const ends = rows.filter((r) => r.event_name === 'daily_limited_end');
  const successEnds = ends.filter((r) => boolParam(r, 'success'));
  const failEnds = ends.filter((r) => !boolParam(r, 'success'));
  const bufferUnlocks = rows.filter((r) => r.event_name === 'daily_limited_buffer_unlock');
  const endedWithUnlock = ends.filter((r) => boolParam(r, 'extra_buffer_unlocked'));
  const durations = ends.map((r) => numParam(r, 'duration_ms')).filter((v) => v > 0);
  const cardClicks = ends.map((r) => numParam(r, 'card_clicks')).filter((v) => v > 0);
  const collected = ends.map((r) => numParam(r, 'collected_count')).filter((v) => v > 0);

  return {
    kpi: {
      total_starts: starts.length,
      total_ends: ends.length,
      start_users: new Set(starts.map((r) => r.uk)).size,
      success_count: successEnds.length,
      fail_count: failEnds.length,
      success_rate: ends.length > 0 ? successEnds.length / ends.length : null,
      avg_duration_ms: avg(durations),
      avg_card_clicks: avg(cardClicks),
      avg_collected_count: avg(collected),
      buffer_unlock_count: bufferUnlocks.length,
      buffer_unlock_users: new Set(bufferUnlocks.map((r) => r.uk)).size,
      ended_with_unlock_count: endedWithUnlock.length,
      share_count: rows.filter((r) => r.event_name === 'daily_limited_recipe_share').length,
      tool_use_count: rows.filter((r) => r.event_name === 'daily_limited_tool_use').length,
      computed_at: Date.now(),
    },
    series: buildDailyLimitedSeries(rows, fromTs, toTs),
    end_reasons: countStringParam(ends, 'end_reason', 'unknown', 'reason'),
    level_distribution: buildDailyLevelDistribution(rows),
    tool_usage: countStringParam(rows.filter((r) => r.event_name === 'daily_limited_tool_use'), 'tool_kind', 'unknown', 'tool_kind'),
  };
}

async function listModeRows(
  gameKey: string,
  eventNames: readonly string[],
  fromTs: number,
  toTs: number,
): Promise<AnalyticsRow[]> {
  const placeholders = eventNames.map(() => '?').join(',');
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(
      `SELECT event_name, event_ts, ${USER_KEY_SQL} AS uk, params_json
         FROM analytics_events
        WHERE game_key = ? AND event_name IN (${placeholders})
          AND event_ts BETWEEN ? AND ?
        ORDER BY event_ts ASC`,
      [gameKey, ...eventNames, fromTs, toTs],
    );
    return rows as AnalyticsRow[];
  }
  return getDb().prepare(
    `SELECT event_name, event_ts, ${USER_KEY_SQL} AS uk, params_json
       FROM analytics_events
      WHERE game_key = ? AND event_name IN (${placeholders})
        AND event_ts BETWEEN ? AND ?
      ORDER BY event_ts ASC`,
  ).all(gameKey, ...eventNames, fromTs, toTs) as AnalyticsRow[];
}

function buildFruitSliceSeries(rows: AnalyticsRow[], fromTs: number, toTs: number): HotpotFruitSliceOverview['series'] {
  const map = new Map<string, HotpotFruitSliceOverview['series'][number]>();
  for (let ts = bucketToTs(tsToBucket(fromTs)); ts <= bucketToTs(tsToBucket(toTs)); ts += BUCKET_SIZE_MS) {
    const bucket = tsToBucket(ts);
    map.set(bucket, { bucket, ts, start_cnt: 0, end_cnt: 0, revive_cnt: 0, tool_cnt: 0 });
  }
  for (const row of rows) {
    const bucket = tsToBucket(Number(row.event_ts));
    const item = map.get(bucket);
    if (!item) continue;
    if (row.event_name === 'fruit_slice_start') item.start_cnt += 1;
    if (row.event_name === 'fruit_slice_end') item.end_cnt += 1;
    if (row.event_name === 'fruit_slice_revive') item.revive_cnt += 1;
    if (row.event_name === 'fruit_slice_tool_use') item.tool_cnt += 1;
  }
  return Array.from(map.values());
}

function buildDailyLimitedSeries(rows: AnalyticsRow[], fromTs: number, toTs: number): HotpotDailyLimitedOverview['series'] {
  const map = new Map<string, HotpotDailyLimitedOverview['series'][number]>();
  for (let ts = bucketToTs(tsToBucket(fromTs)); ts <= bucketToTs(tsToBucket(toTs)); ts += BUCKET_SIZE_MS) {
    const bucket = tsToBucket(ts);
    map.set(bucket, { bucket, ts, start_cnt: 0, success_cnt: 0, fail_cnt: 0, tool_cnt: 0 });
  }
  for (const row of rows) {
    const bucket = tsToBucket(Number(row.event_ts));
    const item = map.get(bucket);
    if (!item) continue;
    if (row.event_name === 'daily_limited_start') item.start_cnt += 1;
    if (row.event_name === 'daily_limited_end' && boolParam(row, 'success')) item.success_cnt += 1;
    if (row.event_name === 'daily_limited_end' && !boolParam(row, 'success')) item.fail_cnt += 1;
    if (row.event_name === 'daily_limited_tool_use') item.tool_cnt += 1;
  }
  return Array.from(map.values());
}

function buildDailyLevelDistribution(rows: AnalyticsRow[]): HotpotDailyLimitedOverview['level_distribution'] {
  const map = new Map<number, HotpotDailyLimitedOverview['level_distribution'][number]>();
  for (const row of rows.filter((r) => r.event_name === 'daily_limited_start' || r.event_name === 'daily_limited_end')) {
    const levelId = numParam(row, 'level_id');
    if (!Number.isFinite(levelId) || levelId <= 0) continue;
    const item = map.get(levelId) || {
      level_id: levelId,
      theme_id: strParam(row, 'theme_id', ''),
      drink_name: strParam(row, 'drink_name', ''),
      starts: 0,
      success: 0,
      fails: 0,
      success_rate: null,
    };
    if (row.event_name === 'daily_limited_start') item.starts += 1;
    if (row.event_name === 'daily_limited_end' && boolParam(row, 'success')) item.success += 1;
    if (row.event_name === 'daily_limited_end' && !boolParam(row, 'success')) item.fails += 1;
    item.success_rate = item.starts > 0 ? item.success / item.starts : null;
    map.set(levelId, item);
  }
  return Array.from(map.values()).sort((a, b) => a.level_id - b.level_id);
}

function buildScoreBuckets(scores: number[]): Array<{ bucket: string; count: number }> {
  const ranges = [
    { bucket: '0-99', min: 0, max: 99 },
    { bucket: '100-299', min: 100, max: 299 },
    { bucket: '300-599', min: 300, max: 599 },
    { bucket: '600-999', min: 600, max: 999 },
    { bucket: '1000+', min: 1000, max: Number.POSITIVE_INFINITY },
  ];
  return ranges.map((r) => ({
    bucket: r.bucket,
    count: scores.filter((score) => score >= r.min && score <= r.max).length,
  }));
}

function countStringParam<K extends 'reason' | 'source' | 'tool_kind'>(
  rows: AnalyticsRow[],
  key: string,
  fallback: string,
  outKey: K,
): Array<Record<K, string> & { count: number }> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const value = strParam(row, key, fallback) || fallback;
    map.set(value, (map.get(value) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([value, count]) => ({ [outKey]: value, count }) as Record<K, string> & { count: number })
    .sort((a, b) => b.count - a.count);
}

function params(row: AnalyticsRow): Record<string, unknown> {
  if (!row.params_json) return {};
  if (typeof row.params_json === 'object') return row.params_json as Record<string, unknown>;
  try {
    return JSON.parse(String(row.params_json)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function numParam(row: AnalyticsRow, key: string): number {
  const value = params(row)[key];
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function strParam(row: AnalyticsRow, key: string, fallback: string): string {
  const value = params(row)[key];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function boolParam(row: AnalyticsRow, key: string): boolean {
  const value = params(row)[key];
  return value === true || value === 'true' || value === 1 || value === '1';
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

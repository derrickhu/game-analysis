import { getMysqlPool } from '../db';
import { HOUR_BUCKET_SIZE_MS, bucketToTs, tsToHourBucket } from './bucket';

const SHARE_EVENT_NAME = 'share_app_message';
const SESSION_START_EVENT_NAME = 'session_start';
const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";

export interface ShareKpi {
  game_key: string;
  from: string;
  to: string;
  share_count: number;
  share_users: number;
  dau: number;
  share_penetration_rate: number;
  share_per_user: number;
}

export interface ShareSeriesPoint {
  hour: string;
  share_count: number;
  share_users: number;
}

export interface ShareEntryBreakdown {
  entry_point: string;
  share_count: number;
  share_users: number;
  latest_title: string;
}

export interface ShareOverview {
  kpi: ShareKpi;
  series_hourly: ShareSeriesPoint[];
  breakdown_by_entry: ShareEntryBreakdown[];
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 100 : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) / 100 : 0;
}

function buildContinuousHourlySeries(
  fromTs: number,
  toTs: number,
  rows: Array<{ event_ts: number; uk: string }>,
): ShareSeriesPoint[] {
  const countMap = new Map<string, number>();
  const userMap = new Map<string, Set<string>>();
  for (const row of rows) {
    const hour = tsToHourBucket(Number(row.event_ts));
    countMap.set(hour, (countMap.get(hour) || 0) + 1);
    let users = userMap.get(hour);
    if (!users) {
      users = new Set<string>();
      userMap.set(hour, users);
    }
    users.add(String(row.uk || ''));
  }

  const fromHourTs = Math.floor(fromTs / HOUR_BUCKET_SIZE_MS) * HOUR_BUCKET_SIZE_MS;
  const toHourTs = Math.floor(toTs / HOUR_BUCKET_SIZE_MS) * HOUR_BUCKET_SIZE_MS;
  const out: ShareSeriesPoint[] = [];
  for (let ts = fromHourTs; ts <= toHourTs; ts += HOUR_BUCKET_SIZE_MS) {
    const hour = tsToHourBucket(ts);
    out.push({
      hour,
      share_count: countMap.get(hour) || 0,
      share_users: userMap.get(hour)?.size || 0,
    });
  }
  return out;
}

/**
 * 分享传播指标（通用）：只统计「发起分享」事件，不声称分享成功或带来回流。
 * 回流归因需要后续接 share_open / invite_accept 等事件，本模块先保守展示发起分享数据。
 */
export async function getShareOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<ShareOverview> {
  const pool = await getMysqlPool();
  const fromBucket = tsToHourBucket(fromTs);
  const toBucket = tsToHourBucket(toTs);

  const [[summaryRows], [seriesRows], [breakdownRows]] = await Promise.all([
    pool.query(
      `SELECT
          COUNT(*) AS share_count,
          COUNT(DISTINCT ${USER_KEY_SQL}) AS share_users
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?
          AND event_ts BETWEEN ? AND ?`,
      [gameKey, SHARE_EVENT_NAME, fromTs, toTs],
    ),
    pool.query(
      `SELECT event_ts, ${USER_KEY_SQL} AS uk
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?
          AND event_ts BETWEEN ? AND ?`,
      [gameKey, SHARE_EVENT_NAME, fromTs, toTs],
    ),
    pool.query(
      `SELECT
          COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.entry_point')), ''), 'unknown') AS entry_point,
          COUNT(*) AS share_count,
          COUNT(DISTINCT ${USER_KEY_SQL}) AS share_users,
          MAX(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(params_json, '$.title')), '')) AS latest_title
         FROM analytics_events
        WHERE game_key = ?
          AND event_name = ?
          AND event_ts BETWEEN ? AND ?
        GROUP BY entry_point
        ORDER BY share_count DESC`,
      [gameKey, SHARE_EVENT_NAME, fromTs, toTs],
    ),
  ]);

  const summary = (summaryRows as Array<{ share_count: number; share_users: number }>)[0];
  const shareCount = Number(summary?.share_count || 0);
  const shareUsers = Number(summary?.share_users || 0);
  const [dauRows] = await pool.query(
    `SELECT COUNT(DISTINCT ${USER_KEY_SQL}) AS dau
       FROM analytics_events
      WHERE game_key = ?
        AND event_name = ?
        AND event_ts BETWEEN ? AND ?`,
    [gameKey, SESSION_START_EVENT_NAME, fromTs, toTs],
  );
  const dau = Number((dauRows as Array<{ dau: number }>)[0]?.dau || 0);

  return {
    kpi: {
      game_key: gameKey,
      from: fromBucket,
      to: toBucket,
      share_count: shareCount,
      share_users: shareUsers,
      dau,
      share_penetration_rate: percent(shareUsers, dau),
      share_per_user: ratio(shareCount, shareUsers),
    },
    series_hourly: buildContinuousHourlySeries(
      bucketToTs(fromBucket),
      bucketToTs(toBucket),
      seriesRows as Array<{ event_ts: number; uk: string }>,
    ),
    breakdown_by_entry: (breakdownRows as Array<{
      entry_point: string;
      share_count: number;
      share_users: number;
      latest_title: string;
    }>).map((row) => ({
      entry_point: row.entry_point || 'unknown',
      share_count: Number(row.share_count || 0),
      share_users: Number(row.share_users || 0),
      latest_title: row.latest_title || '',
    })),
  };
}

import { getDb, getMysqlPool, isMysqlMode } from '../db';
import { PLATFORM_SQL, platformSqlParams } from './platform-filter';

/**
 * 单游戏实时在线曲线。
 *
 * 和总览「当前在线」同一口径：一个点是该时刻往前一个桶内出现过任意事件的去重人数。
 * 桶宽 5 分钟时，超过 5 分钟没有操作就算离线。窗口超过 48 小时改成按小时，
 * 避免一天 288 个点拉到 30 天变成几千个点。
 */
const FIVE_MIN_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const FINE_SPAN_MS = 48 * HOUR_MS;

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";

export interface OnlineCurvePoint {
  /** 桶结束时刻 */
  ts: number;
  label: string;
  online: number;
}

export interface OnlineCurveResult {
  bucket_minutes: number;
  /** 窗口终点就是「现在」，最后一个点可以当成当前在线 */
  live: boolean;
  current: number;
  peak: number;
  peak_label: string;
  points: OnlineCurvePoint[];
}

interface Sample {
  endTs: number;
  live: boolean;
}

function bucketMsFor(fromTs: number, toTs: number): number {
  return toTs - fromTs > FINE_SPAN_MS ? HOUR_MS : FIVE_MIN_MS;
}

function formatLabel(ts: number, withDate: boolean): string {
  const date = new Date(ts);
  const hour = date.getHours();
  const minute = date.getMinutes();
  const clock = `${hour < 10 ? `0${hour}` : hour}:${minute < 10 ? `0${minute}` : minute}`;
  if (!withDate) return clock;
  return `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

function listSamples(fromTs: number, toTs: number, bucketMs: number, live: boolean): Sample[] {
  const samples: Sample[] = [];
  const firstEnd = Math.floor(fromTs / bucketMs) * bucketMs + bucketMs;
  const lastClosedEnd = Math.floor(toTs / bucketMs) * bucketMs;
  for (let end = firstEnd; end <= lastClosedEnd && end <= toTs; end += bucketMs) {
    samples.push({ endTs: end, live: false });
  }
  if (live && toTs > lastClosedEnd) samples.push({ endTs: toTs, live: true });
  if (samples.length === 0) samples.push({ endTs: toTs, live });
  return samples;
}

function bucketEndSql(bucketMs: number): string {
  const shift = bucketMs - 1;
  if (isMysqlMode()) return `((event_ts + ${shift}) DIV ${bucketMs}) * ${bucketMs}`;
  return `CAST((event_ts + ${shift}) / ${bucketMs} AS INTEGER) * ${bucketMs}`;
}

async function queryBuckets(
  gameKey: string,
  fromTs: number,
  toTs: number,
  bucketMs: number,
  platform?: string,
): Promise<Map<number, number>> {
  const platformParams = platformSqlParams(platform);
  const bucketEnd = bucketEndSql(bucketMs);
  const sql = `
    SELECT ${bucketEnd} AS bucket_end,
           COUNT(DISTINCT CONCAT(platform, '#', ${USER_KEY_SQL})) AS online
      FROM analytics_events
     WHERE game_key = ? AND event_ts > ? AND event_ts <= ?${PLATFORM_SQL}
     GROUP BY ${bucketEnd}`;
  const params = [gameKey, fromTs, toTs, ...platformParams];
  const map = new Map<number, number>();
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(sql, params);
    for (const row of rows as Array<{ bucket_end: number; online: number }>) {
      map.set(Number(row.bucket_end), Number(row.online || 0));
    }
    return map;
  }
  const rows = getDb().prepare(sql).all(...params) as Array<{ bucket_end: number; online: number }>;
  for (const row of rows) map.set(Number(row.bucket_end), Number(row.online || 0));
  return map;
}

async function queryLive(
  gameKey: string,
  now: number,
  platform?: string,
): Promise<number> {
  const platformParams = platformSqlParams(platform);
  const sql = `
    SELECT COUNT(DISTINCT CONCAT(platform, '#', ${USER_KEY_SQL})) AS online
      FROM analytics_events
     WHERE game_key = ? AND event_ts > ? AND event_ts <= ?${PLATFORM_SQL}`;
  const params = [gameKey, now - FIVE_MIN_MS, now, ...platformParams];
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(sql, params);
    return Number((rows as Array<{ online: number }>)[0]?.online || 0);
  }
  const row = getDb().prepare(sql).get(...params) as { online: number } | undefined;
  return Number(row?.online || 0);
}

export async function getOnlineCurve(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<OnlineCurveResult> {
  if (toTs < fromTs) {
    return { bucket_minutes: 5, live: false, current: 0, peak: 0, peak_label: '', points: [] };
  }
  const bucketMs = bucketMsFor(fromTs, toTs);
  const live = bucketMs === FIVE_MIN_MS && Date.now() - toTs < 60_000;
  const samples = listSamples(fromTs, toTs, bucketMs, live);
  const queryFrom = Math.max(0, (samples[0]?.endTs || fromTs) - bucketMs);
  const [buckets, liveCount] = await Promise.all([
    queryBuckets(gameKey, queryFrom, toTs, bucketMs, platform),
    live ? queryLive(gameKey, toTs, platform) : Promise.resolve(0),
  ]);
  const withDate = samples.some((sample) => new Date(sample.endTs).getDate() !== new Date(samples[0]!.endTs).getDate());
  const points = samples.map((sample) => ({
    ts: sample.endTs,
    label: formatLabel(sample.endTs, withDate),
    online: sample.live ? liveCount : buckets.get(sample.endTs) || 0,
  }));
  let peak = 0;
  let peakLabel = points[0]?.label || '';
  for (const point of points) {
    if (point.online >= peak) {
      peak = point.online;
      peakLabel = point.label;
    }
  }
  return {
    bucket_minutes: bucketMs / 60_000,
    live,
    current: points[points.length - 1]?.online ?? 0,
    peak,
    peak_label: peakLabel,
    points,
  };
}

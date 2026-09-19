/**
 * 全游戏统一在线时长口径。
 *
 * session_end 多数游戏只有 {reason}，没有 duration_ms。
 * 用「同一用户相邻事件间隔 ≤ 5 分钟」拼会话，单段短于 15 秒不计。
 * 大盘 KPI、玩法面板都走这里，不要各游戏自己再写一套。
 */
import { getMysqlPool } from '../db';
import { PLATFORM_SQL, platformSqlParams } from './platform-filter';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
export const IDLE_GAP_MS = 5 * 60_000;
export const MIN_SESSION_MS = 15_000;

export interface SessionSpan {
  uk: string;
  start: number;
  dur: number;
}

export interface SessionDurationKpi {
  play_users: number;
  session_cnt: number;
  play_minutes: number;
  avg_session_ms: number;
  median_session_ms: number;
  minutes_per_user: number;
  duration_source: 'reconstructed_idle_gap';
}

export interface SessionBucket {
  range_label: string;
  count: number;
}

export function emptyDurationKpi(): SessionDurationKpi {
  return {
    play_users: 0,
    session_cnt: 0,
    play_minutes: 0,
    avg_session_ms: 0,
    median_session_ms: 0,
    minutes_per_user: 0,
    duration_source: 'reconstructed_idle_gap',
  };
}

export function reconstructSessions(rows: Array<{ uk: string; event_ts: number }>): SessionSpan[] {
  const byUser = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.uk) continue;
    const list = byUser.get(row.uk) || [];
    list.push(Number(row.event_ts) || 0);
    byUser.set(row.uk, list);
  }
  const sessions: SessionSpan[] = [];
  for (const [uk, times] of byUser) {
    times.sort((a, b) => a - b);
    let start = times[0] ?? 0;
    let last = start;
    for (let i = 1; i < times.length; i += 1) {
      const t = times[i] ?? last;
      if (t - last > IDLE_GAP_MS) {
        const dur = last - start;
        if (dur >= MIN_SESSION_MS) sessions.push({ uk, start, dur });
        start = t;
      }
      last = t;
    }
    const dur = last - start;
    if (dur >= MIN_SESSION_MS) sessions.push({ uk, start, dur });
  }
  return sessions;
}

export function summarizeSessions(sessions: SessionSpan[]): SessionDurationKpi {
  const playUsers = new Set(sessions.map((s) => s.uk));
  const durs = sessions.map((s) => s.dur).sort((a, b) => a - b);
  const playMs = durs.reduce((sum, v) => sum + v, 0);
  return {
    play_users: playUsers.size,
    session_cnt: sessions.length,
    play_minutes: round1(playMs / 60_000),
    avg_session_ms: avg(durs),
    median_session_ms: median(durs),
    minutes_per_user: playUsers.size > 0 ? round1(playMs / 60_000 / playUsers.size) : 0,
    duration_source: 'reconstructed_idle_gap',
  };
}

export function buildSessionBuckets(durs: number[]): SessionBucket[] {
  const ranges = [
    { range_label: '<1分钟', min: 0, max: 60_000 },
    { range_label: '1-5分钟', min: 60_000, max: 5 * 60_000 },
    { range_label: '5-15分钟', min: 5 * 60_000, max: 15 * 60_000 },
    { range_label: '15-30分钟', min: 15 * 60_000, max: 30 * 60_000 },
    { range_label: '30-60分钟', min: 30 * 60_000, max: 60 * 60_000 },
    { range_label: '60分钟+', min: 60 * 60_000, max: Number.POSITIVE_INFINITY },
  ];
  return ranges.map((r) => ({
    range_label: r.range_label,
    count: durs.filter((d) => d >= r.min && d < r.max).length,
  }));
}

export async function loadSessionDuration(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<{ kpi: SessionDurationKpi; sessions: SessionSpan[] }> {
  const rows = await listEventTimes(gameKey, fromTs, toTs, platform);
  const sessions = reconstructSessions(rows);
  return { kpi: summarizeSessions(sessions), sessions };
}

async function listEventTimes(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<Array<{ uk: string; event_ts: number }>> {
  const platformParams = platformSqlParams(platform);
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT event_ts, ${USER_KEY_SQL} AS uk
       FROM analytics_events
      WHERE game_key = ?
        AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`,
    [gameKey, fromTs, toTs, ...platformParams],
  );
  return rows as Array<{ uk: string; event_ts: number }>;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const mid = values.length >> 1;
  return values.length % 2 === 0
    ? Math.round(((values[mid - 1] ?? 0) + (values[mid] ?? 0)) / 2)
    : (values[mid] ?? 0);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

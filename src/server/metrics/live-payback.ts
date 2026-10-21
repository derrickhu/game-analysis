import { listAdMinute } from '../analytics-db';
import { getEstimatedEcpm } from '../config/ecpm';
import { getMysqlPool } from '../db';
import { listBusinessDailyInputs } from '../ltv-db';
import { tsToBucket } from './bucket';
import { toLocalDateKey } from './ltv';
import { PLATFORM_SQL, normalizePlatformFilter, platformSqlParams } from './platform-filter';
import { aggregateAdMinuteFromEvents } from './realtime-ad';

/**
 * 留存与回本里「今天」这一行。
 * 自然日还没结束，不能等预聚合把 is_complete_day 标成 1。
 * 这里直接数当前已经发生的 session_start / 广告曝光。
 */
const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
const SESSION_START = 'session_start';
const OPEN_AGES = [1, 3, 7] as const;

export interface LiveRetentionPoint {
  cohort_date: string;
  age_day: number;
  cohort_size: number;
  retained_users: number;
  retention_rate: number | null;
}

export interface LivePaybackToday {
  date_key: string;
  new_users: number;
  spend_cny: number;
  revenue_cny: number;
  /** publisher：流量主已有当天收入；estimated：按近期真实 eCPM × 当前曝光 */
  revenue_source: 'publisher' | 'estimated';
  cpi_cny: number | null;
  d0_roi: number | null;
  partials: LiveRetentionPoint[];
}

function dateKeyToStartTs(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00`).getTime();
}

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toLocalDateKey(date.getTime());
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return round4(numerator / denominator);
}

async function loadCohorts(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<Array<{ user_key: string; first_ts: number }>> {
  const pool = await getMysqlPool();
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
  return (rows as Array<{ user_key: string; first_ts: number }>).filter((row) => row.user_key);
}

async function loadReturnedToday(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<Set<string>> {
  const pool = await getMysqlPool();
  const platformParams = platformSqlParams(platform);
  const [rows] = await pool.query(
    `SELECT DISTINCT ${USER_KEY_SQL} AS user_key
       FROM analytics_events
      WHERE game_key = ?
        AND event_name = ?
        AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}`,
    [gameKey, SESSION_START, fromTs, toTs, ...platformParams],
  );
  return new Set(
    (rows as Array<{ user_key: string }>).map((row) => row.user_key).filter(Boolean),
  );
}

async function estimateTodayRevenue(
  gameKey: string,
  fromTs: number,
  toTs: number,
  platform?: string,
): Promise<number> {
  const platformKey = normalizePlatformFilter(platform);
  const fromMinute = tsToBucket(fromTs);
  const toMinute = tsToBucket(toTs);
  let rows = await listAdMinute(gameKey, fromMinute, toMinute, platformKey);
  if (rows.length === 0) {
    rows = await aggregateAdMinuteFromEvents(gameKey, fromMinute, toMinute, platformKey);
  }
  const shows = rows.reduce((sum, row) => sum + Number(row.ad_show_cnt || 0), 0);
  if (shows <= 0) return 0;

  const lookbackStart = toLocalDateKey(fromTs - 14 * 86_400_000);
  const today = toLocalDateKey(fromTs);
  const inputs = await listBusinessDailyInputs(gameKey, lookbackStart, today);
  let revenue = 0;
  let impressions = 0;
  for (const input of inputs) {
    if (input.date_key >= today) continue;
    const dayRevenue = Number(input.wechat_ad_revenue_cny || 0);
    const dayImpressions = Number(input.wechat_ad_impressions || 0);
    if (dayRevenue <= 0 || dayImpressions <= 0) continue;
    revenue += dayRevenue;
    impressions += dayImpressions;
  }
  const ecpm = impressions > 0 ? (revenue / impressions) * 1000 : getEstimatedEcpm(gameKey, 'reward', '');
  return round2((shows / 1000) * ecpm);
}

export async function getLivePaybackToday(
  gameKey: string,
  platform?: string,
  now = Date.now(),
): Promise<LivePaybackToday> {
  const today = toLocalDateKey(now);
  const todayStart = dateKeyToStartTs(today);
  const oldest = addDays(today, -7);
  const [firstSeen, returned, inputs] = await Promise.all([
    loadCohorts(gameKey, dateKeyToStartTs(oldest), now, platform),
    loadReturnedToday(gameKey, todayStart, now, platform),
    listBusinessDailyInputs(gameKey, today, today),
  ]);

  const buckets = new Map<string, { size: number; retained: number }>();
  for (const age of [0, ...OPEN_AGES]) buckets.set(addDays(today, -age), { size: 0, retained: 0 });
  for (const row of firstSeen) {
    const cohortDate = toLocalDateKey(Number(row.first_ts));
    const bucket = buckets.get(cohortDate);
    if (!bucket) continue;
    bucket.size += 1;
    if (returned.has(row.user_key)) bucket.retained += 1;
  }

  const spend = round2(inputs.reduce((sum, row) => sum + Number(row.spend_cny || 0), 0));
  const publisherRevenue = round2(inputs.reduce((sum, row) => sum + Number(row.wechat_ad_revenue_cny || 0), 0));
  const revenueSource = publisherRevenue > 0 ? 'publisher' : 'estimated';
  const revenue = publisherRevenue > 0 ? publisherRevenue : await estimateTodayRevenue(gameKey, todayStart, now, platform);
  const newUsers = buckets.get(today)?.size || 0;

  return {
    date_key: today,
    new_users: newUsers,
    spend_cny: spend,
    revenue_cny: revenue,
    revenue_source: revenueSource,
    cpi_cny: spend > 0 ? ratio(spend, newUsers) : null,
    d0_roi: ratio(revenue, spend),
    partials: OPEN_AGES.map((age) => {
      const cohortDate = addDays(today, -age);
      const bucket = buckets.get(cohortDate) || { size: 0, retained: 0 };
      return {
        cohort_date: cohortDate,
        age_day: age,
        cohort_size: bucket.size,
        retained_users: bucket.retained,
        retention_rate: bucket.size > 0 ? round4(bucket.retained / bucket.size) : null,
      };
    }),
  };
}

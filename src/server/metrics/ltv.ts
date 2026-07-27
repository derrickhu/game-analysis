import { getMysqlPool } from '../db';
import { getEstimatedEcpm } from '../config/ecpm';
import {
  listBusinessDailyInputs,
  listCohortLtvRows,
  listUserDailyRows,
  replaceCohortLtvRows,
  replaceUserDailyRows,
  type CohortLtvDailyRow,
  type UserDailyRow,
} from '../ltv-db';
import {
  PLATFORM_SQL,
  PRECOMPUTE_PLATFORMS,
  normalizePlatformFilter,
  platformSqlParams,
} from './platform-filter';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";
/** 与 realtime-overview / retention 一致：新增、cohort、CPI 分母都以 session_start 为准 */
const SESSION_START = 'session_start';
const TARGET_LTV_DAYS = [0, 1, 3, 7, 14, 30] as const;
const MAX_COHORT_AGE_DAY = 30;

interface RawEventForDaily {
  event_name: string;
  event_ts: number;
  user_key: string;
  params_json: string | Record<string, unknown>;
}

interface FirstSeenRow {
  user_key: string;
  first_ts: number;
}

export interface RecomputeUserDailyResult {
  game_key: string;
  from_date: string;
  to_date: string;
  rows: number;
}

export interface RecomputeLtvResult {
  game_key: string;
  from_cohort_date: string;
  to_cohort_date: string;
  rows: number;
}

export interface LtvApiResult {
  game_key: string;
  estimated: true;
  revenue_type: 'ad_estimated';
  notice: string;
  cohorts: LtvCohort[];
  summary: LtvSummary;
}

interface LtvCohort {
  cohort_date: string;
  cohort_size: number;
  observed_days: number;
  ltv: Record<'d0' | 'd1' | 'd3' | 'd7' | 'd14' | 'd30', number | null> & {
    d30_projected: number | null;
    d60_projected: number | null;
  };
  retention: Record<'d1' | 'd3' | 'd7' | 'd14' | 'd30', number | null>;
  revenue: {
    observed_cny: number;
    projected_d30_cny: number | null;
    projected_d60_cny: number | null;
  };
  points: Array<{
    age_day: number;
    ltv_cny: number;
    retention_rate: number;
    is_complete_day: boolean;
  }>;
}

interface LtvSummary {
  blended_ltv_d0: number | null;
  blended_ltv_d1: number | null;
  blended_ltv_d3: number | null;
  blended_ltv_d7: number | null;
  blended_ltv_d14: number | null;
  blended_ltv_d30: number | null;
  projected_ltv_d30: number | null;
  projected_ltv_d60: number | null;
  total_cohort_size: number;
  total_observed_revenue_cny: number;
  projection_method: 'observed_only' | 'ratio_d7' | 'ratio_d3' | 'insufficient_data';
}

export interface MonetizationResult {
  game_key: string;
  estimated: true;
  notice: string;
  total_days: number;
  active_user_days: number;
  avg_dau: number;
  dau: number;
  new_users: number;
  revenue_estimated_cny: number;
  arpu_estimated_cny: number;
  arpdau_estimated_cny: number;
  ad_uau: number;
  ad_penetration_rate: number;
  ad_show_cnt: number;
  ad_show_per_uu: number;
  ipm: number;
  fill_rate: number;
  completion_rate: number;
  ltv: LtvSummary;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function parseParams(value: string | Record<string, unknown>): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isAdCompleted(params: Record<string, unknown>): boolean {
  const value = params.completed ?? params.is_ended ?? params.isEnded;
  return value === true || value === 1 || value === 'true' || value === '1';
}

export function toLocalDateKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

function normalizeDateRange(fromDate?: string, toDate?: string): { fromDate: string; toDate: string } {
  const today = toLocalDateKey(Date.now());
  return {
    fromDate: fromDate || today,
    toDate: toDate || today,
  };
}

async function buildActualEcpmMap(
  gameKey: string,
  fromDate: string,
  toDate: string,
): Promise<Map<string, number>> {
  const inputs = await listBusinessDailyInputs(gameKey, fromDate, toDate);
  const map = new Map<string, number>();
  for (const input of inputs) {
    const revenue = Number(input.wechat_ad_revenue_cny || 0);
    const impressions = Number(input.wechat_ad_impressions || 0);
    if (revenue > 0 && impressions > 0) {
      map.set(input.date_key, (revenue / impressions) * 1000);
    }
  }
  return map;
}

async function getEventDateRange(gameKey: string): Promise<{ fromDate: string; toDate: string } | null> {
  const pool = await getMysqlPool();
  const [rows] = await pool.query(
    `SELECT MIN(event_ts) AS min_ts, MAX(event_ts) AS max_ts
       FROM analytics_events
      WHERE game_key = ?`,
    [gameKey],
  );
  const row = (rows as Array<{ min_ts: number | null; max_ts: number | null }>)[0];
  if (!row?.min_ts || !row?.max_ts) return null;
  return {
    fromDate: toLocalDateKey(Number(row.min_ts)),
    toDate: toLocalDateKey(Number(row.max_ts)),
  };
}

async function listFirstSeen(gameKey: string, platform: string): Promise<Map<string, string>> {
  const pool = await getMysqlPool();
  const platformParams = platformSqlParams(platform);
  const [rows] = await pool.query(
    `SELECT ${USER_KEY_SQL} AS user_key, MIN(event_ts) AS first_ts
       FROM analytics_events
      WHERE game_key = ?
        AND event_name = ?${PLATFORM_SQL}
      GROUP BY ${USER_KEY_SQL}`,
    [gameKey, SESSION_START, ...platformParams],
  );
  const map = new Map<string, string>();
  for (const row of rows as FirstSeenRow[]) {
    if (!row.user_key) continue;
    map.set(row.user_key, toLocalDateKey(Number(row.first_ts)));
  }
  return map;
}

async function recomputeUserDailyForPlatform(
  gameKey: string,
  fromDate: string,
  toDate: string,
  platform: string,
  actualEcpmByDate: Map<string, number>,
): Promise<number> {
  const fromTs = dateKeyToStartTs(fromDate);
  const toTs = dateKeyToStartTs(addDays(toDate, 1)) - 1;
  const firstSeen = await listFirstSeen(gameKey, platform);
  const pool = await getMysqlPool();
  const platformParams = platformSqlParams(platform);
  const [rows] = await pool.query(
    `SELECT event_name, event_ts, ${USER_KEY_SQL} AS user_key, params_json
       FROM analytics_events
      WHERE game_key = ? AND event_ts BETWEEN ? AND ?${PLATFORM_SQL}
      ORDER BY event_ts ASC`,
    [gameKey, fromTs, toTs, ...platformParams],
  );

  // 是否算"业务活跃"：必须出现至少一个真实用户行为事件，
  // ad_request / ad_error 是系统/SDK 自身行为，不能让"只发了请求没真进游戏"也被算 DAU 和留存。
  // 与 DAU 行业口径（session_start 起算）保持一致，再额外接受其它玩法/广告展示事件兜底。
  const BUSINESS_ACTIVE_EVENTS = new Set([
    'session_start',
    'session_end',
    'ad_show',
    'ad_close',
    'level_start',
    'level_clear',
    'level_fail',
    'share_app_message',
  ]);

  const now = Date.now();
  const dailyMap = new Map<string, UserDailyRow>();
  for (const row of rows as RawEventForDaily[]) {
    const userKey = String(row.user_key || '');
    if (!userKey) continue;
    const dateKey = toLocalDateKey(Number(row.event_ts));
    const firstSeenDate = firstSeen.get(userKey);
    // 无 session_start 的用户不参与 user_daily / cohort / ROI 新增统计；
    // 原先 fallback 到 dateKey 会把 attribution_touchpoint 等前置事件误算为「当天新增」。
    if (!firstSeenDate) continue;
    const key = `${dateKey}|${userKey}`;
    let daily = dailyMap.get(key);
    if (!daily) {
      daily = {
        game_key: gameKey,
        date_key: dateKey,
        user_key: userKey,
        platform,
        first_seen_date: firstSeenDate,
        is_new_user: firstSeenDate === dateKey ? 1 : 0,
        is_active: 0,
        session_cnt: 0,
        session_duration_ms: 0,
        ad_request_cnt: 0,
        ad_show_cnt: 0,
        ad_complete_cnt: 0,
        ad_error_cnt: 0,
        ad_revenue_estimated_cny: 0,
        level_start_cnt: 0,
        level_clear_cnt: 0,
        level_fail_cnt: 0,
        share_cnt: 0,
        created_at: now,
        updated_at: now,
      };
      dailyMap.set(key, daily);
    }
    if (BUSINESS_ACTIVE_EVENTS.has(row.event_name)) {
      daily.is_active = 1;
    }
    const params = parseParams(row.params_json);
    switch (row.event_name) {
      case 'session_start':
        daily.session_cnt += 1;
        break;
      case 'session_end':
        daily.session_duration_ms += readNumber(params.duration_ms ?? params.session_duration_ms);
        break;
      case 'ad_request':
        daily.ad_request_cnt += 1;
        break;
      case 'ad_show': {
        const adType = String(params.ad_type || 'unknown');
        const scene = String(params.scene || 'unknown');
        // 若运营已录入当天微信真实 eCPM，则用真实 eCPM 分摊到当天所有广告展示；
        // 未录入真实曝光/收入的日期再回退到按广告位配置的预估 eCPM。
        const ecpm = actualEcpmByDate.get(dateKey) ?? getEstimatedEcpm(gameKey, adType, scene);
        daily.ad_show_cnt += 1;
        daily.ad_revenue_estimated_cny += ecpm / 1000;
        break;
      }
      case 'ad_close':
        if (isAdCompleted(params)) daily.ad_complete_cnt += 1;
        break;
      case 'ad_error':
        daily.ad_error_cnt += 1;
        break;
      case 'level_start':
        daily.level_start_cnt += 1;
        break;
      case 'level_clear':
        daily.level_clear_cnt += 1;
        break;
      case 'level_fail':
        daily.level_fail_cnt += 1;
        break;
      case 'share_app_message':
        daily.share_cnt += 1;
        break;
    }
  }

  const dailyRows = Array.from(dailyMap.values()).map((row) => ({
    ...row,
    ad_revenue_estimated_cny: round4(row.ad_revenue_estimated_cny),
  }));
  return replaceUserDailyRows(gameKey, fromDate, toDate, platform, dailyRows);
}

export async function recomputeUserDaily(
  gameKey: string,
  options: { fromDate?: string; toDate?: string } = {},
): Promise<RecomputeUserDailyResult> {
  const eventRange = await getEventDateRange(gameKey);
  const normalized = eventRange
    ? {
        fromDate: options.fromDate || eventRange.fromDate,
        toDate: options.toDate || eventRange.toDate,
      }
    : normalizeDateRange(options.fromDate, options.toDate);
  const { fromDate, toDate } = normalized;
  const actualEcpmByDate = await buildActualEcpmMap(gameKey, fromDate, toDate);
  let inserted = 0;
  for (const platform of PRECOMPUTE_PLATFORMS) {
    inserted += await recomputeUserDailyForPlatform(gameKey, fromDate, toDate, platform, actualEcpmByDate);
  }
  return { game_key: gameKey, from_date: fromDate, to_date: toDate, rows: inserted };
}

/**
 * cohort LTV 核心计算：把 user_daily 行按 first_seen_date 分组重算出 D0..D30 的 cohort 汇总。
 * 纯内存计算；recomputeCohortLtv 按平台落库后，读路径直接查表。
 */
export function buildCohortLtvRows(
  gameKey: string,
  userRows: UserDailyRow[],
  fromCohortDate: string,
  toCohortDate: string,
  platform = '',
): CohortLtvDailyRow[] {
  const eligibleRows = userRows.filter(
    (r) => r.first_seen_date >= fromCohortDate && r.first_seen_date <= toCohortDate,
  );
  const byCohort = new Map<string, Map<string, UserDailyRow[]>>();
  for (const row of eligibleRows) {
    let users = byCohort.get(row.first_seen_date);
    if (!users) {
      users = new Map();
      byCohort.set(row.first_seen_date, users);
    }
    const list = users.get(row.user_key) || [];
    list.push(row);
    users.set(row.user_key, list);
  }

  const today = toLocalDateKey(Date.now());
  const now = Date.now();
  const out: CohortLtvDailyRow[] = [];
  for (const [cohortDate, users] of byCohort.entries()) {
    const cohortSize = users.size;
    if (cohortSize === 0) continue;
    const maxAge = Math.min(MAX_COHORT_AGE_DAY, Math.max(0, diffDays(cohortDate, today)));
    for (let ageDay = 0; ageDay <= maxAge; ageDay++) {
      const targetDate = addDays(cohortDate, ageDay);
      let activeUsers = 0;
      let adShowCnt = 0;
      let revenue = 0;
      for (const rowsForUser of users.values()) {
        let userActiveOnTarget = false;
        for (const row of rowsForUser) {
          const age = diffDays(cohortDate, row.date_key);
          if (age < 0 || age > ageDay) continue;
          adShowCnt += Number(row.ad_show_cnt || 0);
          revenue += Number(row.ad_revenue_estimated_cny || 0);
          if (row.date_key === targetDate && row.is_active) userActiveOnTarget = true;
        }
        if (userActiveOnTarget) activeUsers += 1;
      }
      const totalRevenue = round4(revenue);
      out.push({
        game_key: gameKey,
        cohort_date: cohortDate,
        platform,
        age_day: ageDay,
        cohort_size: cohortSize,
        active_users: activeUsers,
        retained_users: activeUsers,
        ad_show_cnt: adShowCnt,
        ad_revenue_estimated_cny: totalRevenue,
        iap_revenue_cny: 0,
        total_revenue_cny: totalRevenue,
        ltv_cny: round4(totalRevenue / cohortSize),
        retention_rate: round4(activeUsers / cohortSize),
        is_complete_day: targetDate < today ? 1 : 0,
        updated_at: now,
      });
    }
  }
  return out;
}

/** 某平台在该游戏下所有曾有 session_start 的 user_key 集合（用于按平台过滤 user_daily/cohort，全生命周期口径，不限时间窗） */
export async function listPlatformUserKeys(gameKey: string, platform: string): Promise<Set<string>> {
  const pool = await getMysqlPool();
  const platformParams = platformSqlParams(platform);
  const [rows] = await pool.query(
    `SELECT DISTINCT ${USER_KEY_SQL} AS user_key
       FROM analytics_events
      WHERE game_key = ? AND event_name = ?${PLATFORM_SQL}`,
    [gameKey, SESSION_START, ...platformParams],
  );
  const set = new Set<string>();
  for (const row of rows as Array<{ user_key: string }>) {
    if (row.user_key) set.add(row.user_key);
  }
  return set;
}

export async function recomputeCohortLtv(
  gameKey: string,
  options: { fromCohortDate?: string; toCohortDate?: string } = {},
): Promise<RecomputeLtvResult> {
  let fromCohortDate = options.fromCohortDate || '';
  let toCohortDate = options.toCohortDate || '';
  let inserted = 0;
  for (const platform of PRECOMPUTE_PLATFORMS) {
    const userRows = await listUserDailyRows(gameKey, platform);
    const cohortDates = userRows.map((r) => r.first_seen_date).sort();
    const platformFrom = options.fromCohortDate || cohortDates[0] || toLocalDateKey(Date.now());
    const platformTo = options.toCohortDate || cohortDates[cohortDates.length - 1] || platformFrom;
    if (!fromCohortDate || platformFrom < fromCohortDate) fromCohortDate = platformFrom;
    if (!toCohortDate || platformTo > toCohortDate) toCohortDate = platformTo;
    const out = buildCohortLtvRows(gameKey, userRows, platformFrom, platformTo, platform);
    inserted += await replaceCohortLtvRows(gameKey, platformFrom, platformTo, platform, out);
  }
  if (!fromCohortDate) fromCohortDate = toLocalDateKey(Date.now());
  if (!toCohortDate) toCohortDate = fromCohortDate;
  return { game_key: gameKey, from_cohort_date: fromCohortDate, to_cohort_date: toCohortDate, rows: inserted };
}

function ltvKey(age: number): 'd0' | 'd1' | 'd3' | 'd7' | 'd14' | 'd30' {
  return `d${age}` as 'd0' | 'd1' | 'd3' | 'd7' | 'd14' | 'd30';
}

function projectFromRows(rows: CohortLtvDailyRow[]): {
  d30: number | null;
  d60: number | null;
  method: LtvSummary['projection_method'];
} {
  // 只用已完整观测的 D3/D7/D30 做外推：cohort 在 D7 当天的 LTV 还在累计中（is_complete_day=0），
  // 直接乘 1.9 会让"今天刚满 D7 的 cohort"被低估为更悲观的 D30，进而误判 ROI 不能回本。
  // 改用 is_complete_day=1 的 row，保证 D7 是真正一整天的累计值。
  const completeByAge = new Map<number, number>();
  for (const r of rows) {
    if (Number(r.is_complete_day) === 1) completeByAge.set(Number(r.age_day), Number(r.ltv_cny));
  }
  const d30 = completeByAge.get(30);
  if (d30 !== undefined) return { d30: round4(d30), d60: null, method: 'observed_only' };
  const d7 = completeByAge.get(7);
  if (d7 !== undefined) return { d30: round4(d7 * 1.9), d60: round4(d7 * 2.4), method: 'ratio_d7' };
  const d3 = completeByAge.get(3);
  if (d3 !== undefined) return { d30: round4(d3 * 3.2), d60: null, method: 'ratio_d3' };
  return { d30: null, d60: null, method: 'insufficient_data' };
}

export async function getLtvOverview(
  gameKey: string,
  fromCohortDate: string,
  toCohortDate: string,
  platform?: string,
): Promise<LtvApiResult> {
  const platformKey = normalizePlatformFilter(platform);
  let notice =
    'LTV 收入优先使用已录入的微信真实 eCPM 计价；缺少真实收入/曝光的日期回退到预估 eCPM，因此仍是按广告展示分摊后的 cohort 收入口径。';
  let rows = await listCohortLtvRows(gameKey, fromCohortDate, toCohortDate, platformKey);
  // 冷启动兜底：该平台预聚合尚未回算完时，临时用按平台的 user_daily 内存重算一次。
  if (rows.length === 0 && platformKey) {
    const userRows = await listUserDailyRows(gameKey, platformKey);
    rows = buildCohortLtvRows(gameKey, userRows, fromCohortDate, toCohortDate, platformKey);
    notice += '（预聚合暂无该平台数据，已实时重算兜底）';
  } else if (platformKey) {
    notice += '（数据来自定时预聚合，按平台）';
  }
  const byCohort = new Map<string, CohortLtvDailyRow[]>();
  for (const row of rows) {
    const list = byCohort.get(row.cohort_date) || [];
    list.push(row);
    byCohort.set(row.cohort_date, list);
  }

  const cohorts: LtvCohort[] = [];
  for (const [cohortDate, cohortRows] of byCohort.entries()) {
    const sorted = cohortRows.sort((a, b) => Number(a.age_day) - Number(b.age_day));
    const byAge = new Map(sorted.map((r) => [Number(r.age_day), r]));
    const projection = projectFromRows(sorted);
    const ltv = {
      d0: null,
      d1: null,
      d3: null,
      d7: null,
      d14: null,
      d30: null,
      d30_projected: projection.d30,
      d60_projected: projection.d60,
    } as LtvCohort['ltv'];
    const retention = { d1: null, d3: null, d7: null, d14: null, d30: null } as LtvCohort['retention'];
    for (const age of TARGET_LTV_DAYS) {
      const row = byAge.get(age);
      if (row) {
        ltv[ltvKey(age)] = round4(Number(row.ltv_cny));
        if (age > 0) retention[ltvKey(age) as keyof LtvCohort['retention']] = round4(Number(row.retention_rate));
      }
    }
    const latest = sorted[sorted.length - 1];
    cohorts.push({
      cohort_date: cohortDate,
      cohort_size: Number(latest?.cohort_size || 0),
      observed_days: Number(latest?.age_day || 0),
      ltv,
      retention,
      revenue: {
        observed_cny: round2(Number(latest?.total_revenue_cny || 0)),
        projected_d30_cny: projection.d30 !== null ? round2(projection.d30 * Number(latest?.cohort_size || 0)) : null,
        projected_d60_cny: projection.d60 !== null ? round2(projection.d60 * Number(latest?.cohort_size || 0)) : null,
      },
      points: sorted.map((r) => ({
        age_day: Number(r.age_day),
        ltv_cny: round4(Number(r.ltv_cny)),
        retention_rate: round4(Number(r.retention_rate)),
        is_complete_day: Number(r.is_complete_day) === 1,
      })),
    });
  }

  return {
    game_key: gameKey,
    estimated: true,
    revenue_type: 'ad_estimated',
    notice,
    cohorts,
    summary: buildSummary(cohorts),
  };
}

function buildSummary(cohorts: LtvCohort[]): LtvSummary {
  const totalSize = cohorts.reduce((sum, c) => sum + c.cohort_size, 0);
  const weighted = (selector: (c: LtvCohort) => number | null): number | null => {
    let numerator = 0;
    let denominator = 0;
    for (const cohort of cohorts) {
      const value = selector(cohort);
      if (value === null || value === undefined) continue;
      numerator += value * cohort.cohort_size;
      denominator += cohort.cohort_size;
    }
    return denominator > 0 ? round4(numerator / denominator) : null;
  };
  const projectionMethods = cohorts.map((c) => projectFromPoints(c.points));
  const method: LtvSummary['projection_method'] =
    projectionMethods.includes('observed_only')
      ? 'observed_only'
      : projectionMethods.includes('ratio_d7')
        ? 'ratio_d7'
        : projectionMethods.includes('ratio_d3')
          ? 'ratio_d3'
          : 'insufficient_data';
  return {
    blended_ltv_d0: weighted((c) => c.ltv.d0),
    blended_ltv_d1: weighted((c) => c.ltv.d1),
    blended_ltv_d3: weighted((c) => c.ltv.d3),
    blended_ltv_d7: weighted((c) => c.ltv.d7),
    blended_ltv_d14: weighted((c) => c.ltv.d14),
    blended_ltv_d30: weighted((c) => c.ltv.d30),
    projected_ltv_d30: weighted((c) => c.ltv.d30_projected),
    projected_ltv_d60: weighted((c) => c.ltv.d60_projected),
    total_cohort_size: totalSize,
    total_observed_revenue_cny: round2(cohorts.reduce((sum, c) => sum + c.revenue.observed_cny, 0)),
    projection_method: method,
  };
}

function projectFromPoints(points: LtvCohort['points']): LtvSummary['projection_method'] {
  // 与 projectFromRows 保持一致：只承认 is_complete_day=true 的观测点，
  // 否则汇总 method 会显示 ratio_d7，而单 cohort 实际还在累计中，前端展示会误导。
  const completeAges = new Set(points.filter((p) => p.is_complete_day).map((p) => p.age_day));
  if (completeAges.has(30)) return 'observed_only';
  if (completeAges.has(7)) return 'ratio_d7';
  if (completeAges.has(3)) return 'ratio_d3';
  return 'insufficient_data';
}

export async function getMonetizationOverview(
  gameKey: string,
  fromDate: string,
  toDate: string,
  platform?: string,
): Promise<MonetizationResult> {
  const platformKey = normalizePlatformFilter(platform);
  const allUserDaily = await listUserDailyRows(gameKey, platformKey);
  let notice = '商业化金额优先使用已录入的微信真实 eCPM 计价；缺少真实收入/曝光的日期回退到预估 eCPM。';
  if (platformKey) notice += '（数据来自定时预聚合，按平台）';
  const rows = allUserDaily.filter((r) => r.date_key >= fromDate && r.date_key <= toDate);
  const activeUsers = new Set(rows.filter((r) => r.is_active).map((r) => r.user_key));
  const newUsers = new Set(rows.filter((r) => r.is_new_user).map((r) => r.user_key));
  const allUsers = new Set(rows.map((r) => r.user_key));
  const adUsers = new Set(rows.filter((r) => Number(r.ad_show_cnt) > 0).map((r) => r.user_key));
  const activeUserDays = rows.filter((r) => r.is_active).length;
  const adUserDays = rows.filter((r) => Number(r.ad_show_cnt) > 0).length;
  const totalDays = Math.max(1, diffDays(fromDate, toDate) + 1);
  const avgDau = activeUserDays / totalDays;
  const revenue = rows.reduce((sum, r) => sum + Number(r.ad_revenue_estimated_cny || 0), 0);
  const adShow = rows.reduce((sum, r) => sum + Number(r.ad_show_cnt || 0), 0);
  const adRequest = rows.reduce((sum, r) => sum + Number(r.ad_request_cnt || 0), 0);
  const adComplete = rows.reduce((sum, r) => sum + Number(r.ad_complete_cnt || 0), 0);
  const ltv = await getLtvOverview(gameKey, fromDate, toDate, platform);
  const dau = activeUsers.size;
  return {
    game_key: gameKey,
    estimated: true,
    notice,
    total_days: totalDays,
    active_user_days: activeUserDays,
    avg_dau: Math.round(avgDau),
    dau,
    new_users: newUsers.size,
    revenue_estimated_cny: round2(revenue),
    arpu_estimated_cny: allUsers.size > 0 ? round4(revenue / allUsers.size) : 0,
    arpdau_estimated_cny: activeUserDays > 0 ? round4(revenue / activeUserDays) : 0,
    ad_uau: adUsers.size,
    ad_penetration_rate: activeUserDays > 0 ? round2((adUserDays / activeUserDays) * 100) : 0,
    ad_show_cnt: adShow,
    ad_show_per_uu: adUserDays > 0 ? round2(adShow / adUserDays) : 0,
    ipm: activeUserDays > 0 ? round2((adShow / activeUserDays) * 1000) : 0,
    fill_rate: adRequest > 0 ? round2((adShow / adRequest) * 100) : 0,
    completion_rate: adShow > 0 ? round2((adComplete / adShow) * 100) : 0,
    ltv: ltv.summary,
  };
}

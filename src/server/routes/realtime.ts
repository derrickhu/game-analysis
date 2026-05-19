import type { FastifyInstance } from 'fastify';

import {
  findAnalyticsGame,
  getEnabledAnalyticsGames,
} from '../config/analytics-games';
import {
  getEventStats,
  listAdMinute,
  listEventNames,
  listEvents,
  listRecentCleanupRuns,
  listRecentIngestRuns,
  type AdMinuteRow,
} from '../analytics-db';
import { cleanExpiredEvents } from '../jobs/clean-expired-events';
import { getEstimatedEcpm } from '../config/ecpm';
import { ingestEventsByGameKey } from '../jobs/ingest-events';
import {
  getAdUserMetrics,
  listAdErrorTopN,
  listSeriesUserBuckets,
  recomputeRealtimeAdMinute,
} from '../metrics/realtime-ad';
import {
  getHuahuaEconomyOverview,
  getHuahuaEngagementOverview,
  getHuahuaGrowthOverview,
  getHuahuaOrderOverview,
} from '../metrics/realtime-huahua';
import {
  getHuahuaSnapshotOverview,
  listHuahuaPlayerSnapshots,
} from '../metrics/realtime-huahua-snapshot';
import {
  getHotpotDailyLimitedOverview,
  getHotpotFruitSliceOverview,
} from '../metrics/realtime-hotpot-modes';
import { ingestHuahuaSnapshots } from '../jobs/ingest-huahua-snapshot';
import { getOverview } from '../metrics/realtime-overview';
import { getProgressOverview } from '../metrics/realtime-progress';
import { getShareOverview } from '../metrics/realtime-share';
import {
  getLtvOverview,
  getMonetizationOverview,
  recomputeCohortLtv,
  recomputeUserDaily,
  toLocalDateKey,
} from '../metrics/ltv';
import {
  findLatestRetentionCohortDate,
  getRetentionCohortRangeOverview,
  getPrecomputedRetentionCohortOverview,
} from '../metrics/retention';
import { recomputeLevelPassRates } from '../metrics/level-pass-rate';
import {
  getBusinessRoiDecision,
  getBusinessRoiOverview,
  removeBusinessDailyInput,
  saveBusinessDailyInput,
} from '../metrics/roi';
import { analyzeRoiWithDeepSeek } from '../metrics/roi-ai';
import {
  BUCKET_SIZE_MS,
  BUCKET_SIZE_MINUTES,
  HOUR_BUCKET_SIZE_MS,
  bucketToTs,
  tsToBucket,
  tsToDayBucket,
  tsToHourBucket,
} from '../metrics/bucket';

const DEFAULT_WINDOW_MINUTES = 60;

/**
 * 解析 from/to/window 三选一的时间窗口入参。
 *
 * 关键不变量：toTs 不允许越过"现在"——
 * - 否则 ad-revenue 的 1 小时桶 series 会按未来时间生成空槽位；
 * - 一旦数据中存在客户端时钟漂移导致的"未来事件"（SDK 上报的 event_ts > now），
 *   未来桶内 active_uu 与 ad_uau 都只剩这条孤儿事件，渗透率会被算成 100% 误导发版分析。
 *
 * windowMinutes 仅在 query.from / query.to 都缺省时作为相对时间 fallback 使用。
 */
function parseTimeRange(query: { from?: string; to?: string; window?: string }): {
  fromTs: number;
  toTs: number;
  windowMinutes: number;
} {
  const windowMinutes = Math.max(5, Math.min(24 * 60, Number(query.window) || DEFAULT_WINDOW_MINUTES));
  const nowTs = Date.now();
  const fromTs = query.from ? bucketToTs(query.from) : nowTs - windowMinutes * 60_000;
  const rawToTs = query.to ? bucketToTs(query.to) : nowTs;
  const toTs = Math.min(rawToTs, nowTs);
  return { fromTs, toTs, windowMinutes };
}

interface AdRevenueQuery {
  game?: string;
  from?: string;
  to?: string;
  window?: string;
}

interface LtvQuery extends AdRevenueQuery {
  from_date?: string;
  to_date?: string;
}

interface RetentionCohortQuery {
  game?: string;
  cohort_date?: string;
  from_date?: string;
  to_date?: string;
  max_age?: string;
}

interface BusinessInputBody {
  game?: string;
  date_key?: string;
  spend_cny?: number;
  wechat_clicks?: number;
  wechat_ad_revenue_cny?: number;
  wechat_ad_impressions?: number;
  note?: string;
}

interface BusinessRoiDecisionQuery {
  game?: string;
  target_date?: string;
  baseline_days?: string;
  maturity_day?: string;
}

interface BusinessRoiAiBody {
  game?: string;
  baseline_days?: number;
  maturity_day?: number;
}

interface LevelPassRateBody {
  game?: string;
  window_days?: number;
  publish?: boolean;
}

interface AdRevenueSeriesItem {
  minute: string;
  ad_request_cnt: number;
  ad_show_cnt: number;
  ad_click_cnt: number;
  ad_complete_cnt: number;
  ad_error_cnt: number;
  ad_revenue_estimated_cny: number;
  // 桶级用户视角指标，前端「关键变现指标趋势」直接消费
  // 设计取舍：只在 series 里输出，不再额外做小时桶/日桶——发版前后看 5 分钟桶足够细
  /** 该 5 分钟桶看广告去重用户数（ad_show 事件） */
  ad_uau: number;
  /**
   * 该 5 分钟桶在线 UAU（任意事件去重用户）。
   * 桶级分母不能用 session_start——session_start 只在会话开始那一桶有，会让后续桶分母为 0、渗透率爆到 100%+。
   * 改用「该桶任意事件的去重用户」语义=「这 5 分钟有多少人在线」，确保 ad_uau ≤ active_uu。
   * KPI 区的窗口级 dau 仍走 session_start，与 overview 同口径，两个 dau 不冲突。
   */
  dau: number;
  /** 该桶人均广告次数：ad_show_cnt / ad_uau */
  ad_show_per_uu: number;
  /** 该桶广告渗透率(%)：ad_uau / 在线 UAU，<=100% */
  ad_penetration_rate: number;
  /** 该桶估算 5 分钟人均收入（元）：ad_revenue / 在线 UAU，等价 5 分钟尺度的 ARPDAU 而非自然日 */
  arpdau_estimated_cny: number;
}

interface AdRevenueSummary {
  game_key: string;
  from: string;
  to: string;
  total_show: number;
  total_click: number;
  total_complete: number;
  total_request: number;
  total_error: number;
  total_revenue_estimated_cny: number;
  ctr: number;
  completion_rate: number;
  /** 整窗口加权平均 eCPM（元/千曝光），= total_revenue / total_show * 1000，便于 dashboard 一眼看出量级 */
  avg_ecpm_cny: number;
  /** 看广告 UAU：当前窗口内 ad_show 事件去重用户数 */
  ad_uau: number;
  /** DAU：当前窗口内 session_start 事件去重用户数（与 overview 同口径） */
  dau: number;
  /** 广告渗透率（%）：ad_uau / dau */
  ad_penetration_rate: number;
  /** 人均广告次数：total_show / ad_uau */
  ad_show_per_uu: number;
  /** 估算 ARPDAU（元）：total_revenue / dau，估算口径，非真实结算 */
  arpdau_estimated_cny: number;
  /** 填充率（%）：total_show / total_request，<80% 视为异常 */
  fill_rate: number;
  /** 错误率（%）：total_error / total_request，>5% 视为异常 */
  error_rate: number;
}

interface AdRevenueBreakdown {
  ad_type: string;
  scene: string;
  /** 请求数：上游 ad_request 事件总数，与 fill_rate / error_rate 配对使用 */
  ad_request_cnt: number;
  ad_show_cnt: number;
  ad_click_cnt: number;
  ad_complete_cnt: number;
  /** 错误数：ad_error 事件总数，前端按 ad_error / ad_request 现算错误率 */
  ad_error_cnt: number;
  ad_revenue_estimated_cny: number;
  /** 该 (ad_type, scene) 命中的 eCPM 配置（元/千曝光），让用户能反查到底是哪个口径算出来的 */
  ecpm_cny: number;
}

/**
 * 小时桶 series 项。字段与 5 分钟桶 series 相同（次数 + 派生指标），
 * 只是 minute 字段实际写的是 YYYY-MM-DDTHH:00（小时起点），前端 formatMinuteLabel 复用。
 */
type AdRevenueHourlySeriesItem = AdRevenueSeriesItem;

interface AdRevenueResponse {
  ok: true;
  estimated: true;
  notice: string;
  query: { game_key: string; from: string; to: string; window_minutes: number };
  summary: AdRevenueSummary;
  series: AdRevenueSeriesItem[];
  /** 同窗口的小时桶聚合，给「关键变现指标趋势」长尺度对比图使用，避免 5 分钟桶过密 */
  series_hourly: AdRevenueHourlySeriesItem[];
  /** 同窗口的天桶聚合，给跨日观察使用 */
  series_daily: AdRevenueHourlySeriesItem[];
  breakdown_by_scene: AdRevenueBreakdown[];
}

/** 给 series 每个槽位的新字段先填 0，handler 拿到桶级 user 集合后再 patch 派生指标 */
function emptySeriesItem(minute: string): AdRevenueSeriesItem {
  return {
    minute,
    ad_request_cnt: 0,
    ad_show_cnt: 0,
    ad_click_cnt: 0,
    ad_complete_cnt: 0,
    ad_error_cnt: 0,
    ad_revenue_estimated_cny: 0,
    ad_uau: 0,
    dau: 0,
    ad_show_per_uu: 0,
    ad_penetration_rate: 0,
    arpdau_estimated_cny: 0,
  };
}

function buildContinuousSeries(
  rows: AdMinuteRow[],
  fromBucket: string,
  toBucket: string,
): AdRevenueSeriesItem[] {
  const map = new Map<string, AdRevenueSeriesItem>();
  for (const row of rows) {
    const item = map.get(row.minute_bucket) || emptySeriesItem(row.minute_bucket);
    item.ad_request_cnt += row.ad_request_cnt;
    item.ad_show_cnt += row.ad_show_cnt;
    item.ad_click_cnt += row.ad_click_cnt;
    item.ad_complete_cnt += row.ad_complete_cnt;
    item.ad_error_cnt += row.ad_error_cnt;
    item.ad_revenue_estimated_cny += row.ad_revenue_estimated_cny;
    map.set(row.minute_bucket, item);
  }
  // 按 bucket 粒度（5 分钟）补齐槽位，避免前端图表 X 轴出现 1 分钟假刻度
  const fromTs = bucketToTs(fromBucket);
  const toTs = bucketToTs(toBucket);
  const series: AdRevenueSeriesItem[] = [];
  for (let ts = fromTs; ts <= toTs; ts += BUCKET_SIZE_MS) {
    const m = tsToBucket(ts);
    series.push(map.get(m) || emptySeriesItem(m));
  }
  return series;
}

/**
 * 把桶级 ad_uau / 在线 UAU 集合的人数 patch 进 series，并现算 3 个派生比例。
 * - 桶级渗透率 / ARPDAU 分母统一用「该桶在线 UAU」（任意事件去重），保证 ad_uau ≤ active_uu
 * - 旧实现用 session_start 当分母会让晚到的桶分母为 0、渗透率爆到 200%+，已经修正
 * - 桶级在线 UAU 为 0 时（该桶无任何事件）派生指标置 0，前端按缺口处理
 *
 * 同时支持 5 分钟与 1 小时两种粒度，调用方传入对应的 buckets 即可。
 */
function patchSeriesUserMetrics(
  series: AdRevenueSeriesItem[],
  buckets: { adUau: Map<string, Set<string>>; activeUu: Map<string, Set<string>> },
): void {
  for (const item of series) {
    const adUau = buckets.adUau.get(item.minute)?.size ?? 0;
    const activeUu = buckets.activeUu.get(item.minute)?.size ?? 0;
    item.ad_uau = adUau;
    // 字段名仍叫 dau 是为了不破坏前端契约，语义为「该桶在线 UAU」
    item.dau = activeUu;
    item.ad_show_per_uu = adUau > 0 ? Math.round((item.ad_show_cnt / adUau) * 100) / 100 : 0;
    item.ad_penetration_rate =
      activeUu > 0 ? Math.round((adUau / activeUu) * 10000) / 100 : 0;
    item.arpdau_estimated_cny =
      activeUu > 0 ? Math.round((item.ad_revenue_estimated_cny / activeUu) * 100) / 100 : 0;
  }
}

/**
 * 把 5 分钟 series 折叠成连续的小时桶 series。
 * - 计数指标可加：ad_request / ad_show / ad_click / ad_complete / ad_error / revenue 直接 sum
 * - 用户指标 ad_uau / 在线 UAU 不能直接相加（同一用户跨多个 5 分钟桶会被重复计数），
 *   由调用方再用 patchSeriesUserMetrics 配合小时桶 user 集合 patch 一次
 * - 与 buildContinuousSeries 同样按粒度补齐空槽位，避免前端 X 轴出现断点
 */
function foldHourlySeries(
  fiveMinSeries: AdRevenueSeriesItem[],
  fromBucket: string,
  toBucket: string,
): AdRevenueHourlySeriesItem[] {
  const map = new Map<string, AdRevenueHourlySeriesItem>();
  for (const item of fiveMinSeries) {
    const hourKey = tsToHourBucket(bucketToTs(item.minute));
    const acc = map.get(hourKey) || emptySeriesItem(hourKey);
    acc.ad_request_cnt += item.ad_request_cnt;
    acc.ad_show_cnt += item.ad_show_cnt;
    acc.ad_click_cnt += item.ad_click_cnt;
    acc.ad_complete_cnt += item.ad_complete_cnt;
    acc.ad_error_cnt += item.ad_error_cnt;
    acc.ad_revenue_estimated_cny += item.ad_revenue_estimated_cny;
    map.set(hourKey, acc);
  }
  // 按小时粒度补齐：from 落到所在小时起点，to 落到所在小时起点（含端）
  const fromHourTs = Math.floor(bucketToTs(fromBucket) / HOUR_BUCKET_SIZE_MS) * HOUR_BUCKET_SIZE_MS;
  const toHourTs = Math.floor(bucketToTs(toBucket) / HOUR_BUCKET_SIZE_MS) * HOUR_BUCKET_SIZE_MS;
  const out: AdRevenueHourlySeriesItem[] = [];
  for (let ts = fromHourTs; ts <= toHourTs; ts += HOUR_BUCKET_SIZE_MS) {
    const k = tsToHourBucket(ts);
    out.push(map.get(k) || emptySeriesItem(k));
  }
  // 收益取 2 位小数，避免浮点累加尾数
  for (const item of out) {
    item.ad_revenue_estimated_cny = Math.round(item.ad_revenue_estimated_cny * 100) / 100;
  }
  return out;
}

function foldDailySeries(
  fiveMinSeries: AdRevenueSeriesItem[],
  fromBucket: string,
  toBucket: string,
): AdRevenueHourlySeriesItem[] {
  const map = new Map<string, AdRevenueHourlySeriesItem>();
  for (const item of fiveMinSeries) {
    const dayKey = tsToDayBucket(bucketToTs(item.minute));
    const acc = map.get(dayKey) || emptySeriesItem(dayKey);
    acc.ad_request_cnt += item.ad_request_cnt;
    acc.ad_show_cnt += item.ad_show_cnt;
    acc.ad_click_cnt += item.ad_click_cnt;
    acc.ad_complete_cnt += item.ad_complete_cnt;
    acc.ad_error_cnt += item.ad_error_cnt;
    acc.ad_revenue_estimated_cny += item.ad_revenue_estimated_cny;
    map.set(dayKey, acc);
  }
  const fromDayTs = bucketToTs(tsToDayBucket(bucketToTs(fromBucket)));
  const toDayTs = bucketToTs(tsToDayBucket(bucketToTs(toBucket)));
  const out: AdRevenueHourlySeriesItem[] = [];
  for (let ts = fromDayTs; ts <= toDayTs; ts += 24 * HOUR_BUCKET_SIZE_MS) {
    const k = tsToDayBucket(ts);
    out.push(map.get(k) || emptySeriesItem(k));
  }
  for (const item of out) {
    item.ad_revenue_estimated_cny = Math.round(item.ad_revenue_estimated_cny * 100) / 100;
  }
  return out;
}

function buildBreakdown(gameKey: string, rows: AdMinuteRow[]): AdRevenueBreakdown[] {
  const map = new Map<string, AdRevenueBreakdown>();
  for (const row of rows) {
    const key = `${row.ad_type}|${row.scene}`;
    const item = map.get(key) || {
      ad_type: row.ad_type,
      scene: row.scene,
      ad_request_cnt: 0,
      ad_show_cnt: 0,
      ad_click_cnt: 0,
      ad_complete_cnt: 0,
      ad_error_cnt: 0,
      ad_revenue_estimated_cny: 0,
      // (ad_type, scene) 命中的 eCPM 是固定值，所以同一行所有 row 应当一致；这里用任意一行查表都行
      ecpm_cny: getEstimatedEcpm(gameKey, row.ad_type, row.scene),
    };
    item.ad_request_cnt += row.ad_request_cnt;
    item.ad_show_cnt += row.ad_show_cnt;
    item.ad_click_cnt += row.ad_click_cnt;
    item.ad_complete_cnt += row.ad_complete_cnt;
    item.ad_error_cnt += row.ad_error_cnt;
    item.ad_revenue_estimated_cny += row.ad_revenue_estimated_cny;
    map.set(key, item);
  }
  return Array.from(map.values()).sort((a, b) => b.ad_revenue_estimated_cny - a.ad_revenue_estimated_cny);
}

export async function registerRealtimeRoutes(app: FastifyInstance): Promise<void> {
  // 广告实时收益（估算值，金额来自 ad_show_cnt × ECPM 配置表）
  app.get('/api/realtime/ad-revenue', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }

    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    // bucket 字符串严格落在 5 分钟整点；前端 X 轴据此渲染，不会再出现 1 分钟假刻度
    const fromMinute = tsToBucket(fromTs);
    const toMinute = tsToBucket(toTs);

    const rows = await listAdMinute(gameKey, fromMinute, toMinute);
    const series = buildContinuousSeries(rows, fromMinute, toMinute);
    const breakdown = buildBreakdown(gameKey, rows);
    // 一次 SQL 同时折 5 分钟桶 + 1 小时桶用户集合，避免分别扫两遍
    const seriesUserBuckets = await listSeriesUserBuckets(gameKey, fromTs, toTs);
    patchSeriesUserMetrics(series, seriesUserBuckets);
    // 小时桶 series 给「关键变现指标趋势」长尺度对比图用，单独保留 5 分钟 series 给主图（曝光/收益）
    const seriesHourly = foldHourlySeries(series, fromMinute, toMinute);
    patchSeriesUserMetrics(seriesHourly, {
      adUau: seriesUserBuckets.adUauHourly,
      activeUu: seriesUserBuckets.activeUuHourly,
    });
    const seriesDaily = foldDailySeries(series, fromMinute, toMinute);
    patchSeriesUserMetrics(seriesDaily, {
      adUau: seriesUserBuckets.adUauDaily,
      activeUu: seriesUserBuckets.activeUuDaily,
    });

    let totalShow = 0;
    let totalClick = 0;
    let totalComplete = 0;
    let totalRequest = 0;
    let totalError = 0;
    let totalRevenue = 0;
    for (const r of rows) {
      totalShow += r.ad_show_cnt;
      totalClick += r.ad_click_cnt;
      totalComplete += r.ad_complete_cnt;
      totalRequest += r.ad_request_cnt;
      totalError += r.ad_error_cnt;
      totalRevenue += r.ad_revenue_estimated_cny;
    }
    const ctr = totalShow > 0 ? Math.round((totalClick / totalShow) * 10000) / 100 : 0;
    const completionRate = totalShow > 0 ? Math.round((totalComplete / totalShow) * 10000) / 100 : 0;
    // 反向算回平均 eCPM：场景之间 eCPM 不一样时，用按曝光数加权得出的"实际"eCPM 比单看一个场景更代表整体收益密度
    const avgEcpm = totalShow > 0 ? Math.round((totalRevenue / totalShow) * 1000 * 100) / 100 : 0;
    // 漏斗健康度：fill / error 直接由 totals 派生，不需要二次扫表
    const fillRate = totalRequest > 0 ? Math.round((totalShow / totalRequest) * 10000) / 100 : 0;
    const errorRate = totalRequest > 0 ? Math.round((totalError / totalRequest) * 10000) / 100 : 0;
    // 用户维度指标：与 ad-revenue 共用 [fromTs, toTs] 窗口口径，避免按自然日跨窗口漂移
    const userMetrics = await getAdUserMetrics(gameKey, fromTs, toTs, totalShow, totalRevenue);

    const response: AdRevenueResponse = {
      ok: true,
      estimated: true,
      notice: '所有金额均为基于预估 eCPM 的估算值（按 (game.adType.scene)→(game.adType)→兜底 多级查表），并非真实结算收入；以微信流量主结算数据为准。',
      query: { game_key: gameKey, from: fromMinute, to: toMinute, window_minutes: windowMinutes },
      summary: {
        game_key: gameKey,
        from: fromMinute,
        to: toMinute,
        total_show: totalShow,
        total_click: totalClick,
        total_complete: totalComplete,
        total_request: totalRequest,
        total_error: totalError,
        total_revenue_estimated_cny: Math.round(totalRevenue * 100) / 100,
        ctr,
        completion_rate: completionRate,
        avg_ecpm_cny: avgEcpm,
        ad_uau: userMetrics.ad_uau,
        dau: userMetrics.dau,
        ad_penetration_rate: userMetrics.ad_penetration_rate,
        ad_show_per_uu: userMetrics.ad_show_per_uu,
        arpdau_estimated_cny: userMetrics.arpdau_estimated_cny,
        fill_rate: fillRate,
        error_rate: errorRate,
      },
      series,
      series_hourly: seriesHourly,
      series_daily: seriesDaily,
      breakdown_by_scene: breakdown,
    };
    return response;
  });

  // 上报系统健康度
  app.get('/api/realtime/health', async (request) => {
    const query = (request.query || {}) as { game?: string };
    const gameKey = query.game;
    if (gameKey && !findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const stats = await getEventStats(gameKey);
    // recent_runs 多取一些再做过滤，避免 enabled 游戏少时被未接入游戏的脏记录抢占名额
    const allRuns = await listRecentIngestRuns(100);
    const enabledKeys = new Set(getEnabledAnalyticsGames().map((g) => g.gameKey));
    const filteredRuns = allRuns
      .filter((r) => enabledKeys.has(r.game_key))           // 永远只展示已接入游戏
      .filter((r) => !gameKey || r.game_key === gameKey)    // 顶部选了哪个游戏就只看哪个
      .slice(0, 20);
    return {
      ok: true,
      // 只对外暴露已接入的游戏，dashboard UI 不显示未接入游戏的"虚假在线"
      games: getEnabledAnalyticsGames().map((g) => ({ game_key: g.gameKey, display_name: g.displayName, cloud_env: g.cloudEnv })),
      stats,
      recent_runs: filteredRuns,
    };
  });

  /**
   * 手动触发一次过期事件清理（dashboard 按钮 / 排障入口）。
   *
   * 强制做了几道防线：
   * - dry_run=true（默认）只数将要删多少，不真删；第一次必须用 dry-run 验证
   * - 走 cleanExpiredEvents 同一函数，与 cron 完全一致的白名单守卫 + 限速 + 入库记录
   * - 不允许通过 query 覆盖 retention：参数走环境变量，避免有人传 retention=0 误删全部
   * - trigger_source 强制写 'manual'，便于在历史里和 cron 自动跑区分
   */
  app.post('/api/realtime/cleanup-now', async (request) => {
    const body = (request.body || {}) as { dry_run?: boolean | string | number };
    const rawDry = body.dry_run;
    // 默认 dry_run=true，必须显式传 false / "false" / 0 才真删
    const dryRun = !(rawDry === false || rawDry === 'false' || rawDry === 0 || rawDry === '0');
    const legacyRetention = Number(process.env.ANALYTICS_RETENTION_DAYS);
    const retentionDaysLocal =
      Number(process.env.ANALYTICS_RETENTION_DAYS_LOCAL) ||
      (Number.isFinite(legacyRetention) && legacyRetention > 0 ? legacyRetention : 90);
    const retentionDaysCloud =
      Number(process.env.ANALYTICS_RETENTION_DAYS_CLOUD) ||
      (Number.isFinite(legacyRetention) && legacyRetention > 0 ? legacyRetention : 7);
    const summary = await cleanExpiredEvents({
      retentionDaysLocal,
      retentionDaysCloud,
      dryRun,
      triggerSource: 'manual',
    });
    return { ok: true, ...summary };
  });

  /** 查清理历史，dashboard 卡片用 */
  app.get('/api/realtime/cleanup-history', async (request) => {
    const query = (request.query || {}) as { limit?: string };
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const rows = await listRecentCleanupRuns(limit);
    return { ok: true, runs: rows };
  });

  // 手动触发一次 events 拉取（用于联调和故障排查）
  app.post('/api/realtime/ingest-now', async (request) => {
    const body = (request.body || {}) as { game?: string };
    const gameKey = body.game || 'hotpot';
    const summary = await ingestEventsByGameKey(gameKey);
    return { ok: true, ...summary };
  });

  // 手动重算指定时间窗口的 ad bucket 聚合
  // 使用场景：1) 切换 bucket 粒度后清理旧数据；2) eCPM 配置调整后回填历史；3) 排障
  // body: { game?: string; window_hours?: number }，默认重算最近 24 小时
  app.post('/api/realtime/recompute-buckets', async (request) => {
    const body = (request.body || {}) as { game?: string; window_hours?: number };
    const gameKey = body.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const windowHours = Math.max(1, Math.min(24 * 30, Number(body.window_hours) || 24));
    const toTs = Date.now();
    const fromTs = toTs - windowHours * 3600_000;
    const rows = await recomputeRealtimeAdMinute(gameKey, fromTs, toTs);
    return { ok: true, game: gameKey, window_hours: windowHours, bucket_rows: rows };
  });

  // 通用 LTV/商业化底座回算：按 gameKey + 日期范围重建 user_daily 与 cohort_ltv。
  // body: { game?: string; from_date?: 'YYYY-MM-DD'; to_date?: 'YYYY-MM-DD' }
  app.post('/api/realtime/recompute-ltv', async (request) => {
    const body = (request.body || {}) as { game?: string; from_date?: string; to_date?: string };
    const gameKey = body.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const userDaily = await recomputeUserDaily(gameKey, {
      fromDate: body.from_date,
      toDate: body.to_date,
    });
    const cohort = await recomputeCohortLtv(gameKey, {
      fromCohortDate: body.from_date,
      toCohortDate: body.to_date,
    });
    return { ok: true, user_daily: userDaily, cohort_ltv: cohort };
  });

  // 手动回算闯关模式近 N 天通关率，并发布最新 30 天快照给 hot-pot 读取。
  app.post('/api/realtime/recompute-level-pass-rates', async (request) => {
    const body = (request.body || {}) as LevelPassRateBody;
    const gameKey = body.game || 'hotpot';
    if (gameKey !== 'hotpot') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'level-pass-rates 当前只支持 hotpot' };
    }
    try {
      const result = await recomputeLevelPassRates({
        gameKey,
        windowDays: Number(body.window_days) || 30,
        publish: body.publish !== false,
      });
      return { ok: true, ...result };
    } catch (error) {
      return {
        ok: false,
        code: 'RECOMPUTE_LEVEL_PASS_RATES_FAILED',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  // 通用看板数据：DAU / 当日新增 / 次留 / 7留 / 5 分钟桶活跃序列
  // 与 ad-revenue 共用 from/to/window 入参口径，前端可以并排查询
  app.get('/api/realtime/overview', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const fromBucket = tsToBucket(fromTs);
    const toBucket = tsToBucket(toTs);

    const result = await getOverview(gameKey, fromTs, toTs);
    return {
      ok: true,
      query: { game_key: gameKey, from: fromBucket, to: toBucket, window_minutes: windowMinutes },
      kpi: result.kpi,
      series: result.series,
    };
  });

  // 通用 LTV Cohort：所有已接入 SDK 的游戏共用，hotpot 只是首个回算样本。
  app.get('/api/realtime/ltv', async (request) => {
    const query = (request.query || {}) as LtvQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const fromDate = query.from_date || toLocalDateKey(fromTs);
    const toDate = query.to_date || toLocalDateKey(toTs);
    const result = await getLtvOverview(gameKey, fromDate, toDate);
    return {
      ok: true,
      query: { game_key: gameKey, from_date: fromDate, to_date: toDate, window_minutes: windowMinutes },
      ...result,
    };
  });

  // 通用商业化概览：ARPU/ARPDAU/IPM/填充率/完播率/LTV summary。
  app.get('/api/realtime/monetization', async (request) => {
    const query = (request.query || {}) as LtvQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const fromDate = query.from_date || toLocalDateKey(fromTs);
    const toDate = query.to_date || toLocalDateKey(toTs);
    const result = await getMonetizationOverview(gameKey, fromDate, toDate);
    return {
      ok: true,
      query: { game_key: gameKey, from_date: fromDate, to_date: toDate, window_minutes: windowMinutes },
      ...result,
    };
  });

  // 通用 cohort 留存分析：按某个新增日期 cohort 输出 D0-D30 留存曲线，并按设备类型拆分。
  app.get('/api/realtime/retention-cohort', async (request) => {
    const query = (request.query || {}) as RetentionCohortQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const maxAge = Number(query.max_age) || 30;
    const defaultCohortDate =
      query.cohort_date || (await findLatestRetentionCohortDate(gameKey, Math.min(maxAge, 7))) || toLocalDateKey(Date.now() - 86_400_000);
    const cohortDate = String(defaultCohortDate).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cohortDate)) {
      return { ok: false, code: 'INVALID_DATE', error: 'cohort_date 必须是 YYYY-MM-DD' };
    }
    const result = await getPrecomputedRetentionCohortOverview(gameKey, cohortDate, {
      maxAge,
    });
    return { ok: true, ...result };
  });

  // 多天 cohort 留存分析：一次性返回日期范围内所有 cohort，用于趋势图和留存矩阵。
  app.get('/api/realtime/retention-cohorts', async (request) => {
    const query = (request.query || {}) as RetentionCohortQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const today = toLocalDateKey(Date.now());
    const defaultToDate = toLocalDateKey(Date.now() - 86_400_000);
    const defaultFromDate = toLocalDateKey(Date.now() - 14 * 86_400_000);
    let fromDate = String(query.from_date || defaultFromDate).trim();
    let toDate = String(query.to_date || defaultToDate).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      return { ok: false, code: 'INVALID_DATE', error: 'from_date/to_date 必须是 YYYY-MM-DD' };
    }
    // 留存是 cohort 自然日分析，今天的 cohort 还没完整结束。用户从顶部时间窗口或日历误选今天时，
    // 自动回退到昨天，而不是返回错误后让前端显示 0，避免误以为没有数据。
    if (toDate >= today) {
      toDate = defaultToDate;
    }
    if (fromDate > toDate) {
      fromDate = toLocalDateKey(new Date(`${toDate}T00:00:00`).getTime() - 13 * 86_400_000);
    }
    const result = await getRetentionCohortRangeOverview(gameKey, fromDate, toDate, {
      maxAge: Number(query.max_age) || 30,
    });
    return { ok: true, ...result };
  });

  // 通用每日经营录入 + ROI：人工录入投放消耗、微信点击/真实收入/真实曝光，
  // 系统自动关联 gameKey 下的新增用户、LTV 和估算收入。所有游戏共用同一口径。
  app.get('/api/realtime/business-inputs', async (request) => {
    const query = (request.query || {}) as LtvQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const fromDate = query.from_date || toLocalDateKey(fromTs);
    const toDate = query.to_date || toLocalDateKey(toTs);
    const result = await getBusinessRoiOverview(gameKey, fromDate, toDate);
    return {
      ok: true,
      query: { game_key: gameKey, from_date: fromDate, to_date: toDate, window_minutes: windowMinutes },
      ...result,
    };
  });

  // ROI 投放决策：选择目标日期，用目标日前成熟样本做基线，输出是否放量/观察/降预算。
  app.get('/api/realtime/business-roi-decision', async (request) => {
    const query = (request.query || {}) as BusinessRoiDecisionQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const targetDate = String(query.target_date || toLocalDateKey(Date.now())).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      return { ok: false, code: 'INVALID_DATE', error: 'target_date 必须是 YYYY-MM-DD' };
    }
    const maturityDay = Number(query.maturity_day) === 7 ? 7 : 3;
    const result = await getBusinessRoiDecision(gameKey, {
      targetDate,
      baselineDays: Number(query.baseline_days) || 7,
      maturityDay,
    });
    return { ok: true, ...result };
  });

  // AI 盈利分析：汇总真实 ROI、LTV/留存、规则决策与预算建议后交给 DeepSeek 做结论分析。
  app.post('/api/realtime/business-roi-ai-analysis', async (request) => {
    const body = (request.body || {}) as BusinessRoiAiBody;
    const gameKey = body.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    try {
      const result = await analyzeRoiWithDeepSeek(gameKey, {
        baselineDays: Number(body.baseline_days) || 7,
        maturityDay: Number(body.maturity_day) === 7 ? 7 : 3,
      });
      return { ok: true, ...result };
    } catch (error) {
      return {
        ok: false,
        code: 'AI_ANALYSIS_FAILED',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.post('/api/realtime/business-inputs', async (request) => {
    const body = (request.body || {}) as BusinessInputBody;
    const gameKey = body.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const dateKey = String(body.date_key || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return { ok: false, code: 'INVALID_DATE', error: 'date_key 必须是 YYYY-MM-DD' };
    }
    const row = await saveBusinessDailyInput({
      game_key: gameKey,
      date_key: dateKey,
      spend_cny: Math.max(0, Number(body.spend_cny) || 0),
      wechat_clicks: Math.max(0, Math.trunc(Number(body.wechat_clicks) || 0)),
      wechat_ad_revenue_cny: Math.max(0, Number(body.wechat_ad_revenue_cny) || 0),
      wechat_ad_impressions: Math.max(0, Math.trunc(Number(body.wechat_ad_impressions) || 0)),
      note: body.note || '',
    });
    return { ok: true, row };
  });

  app.delete('/api/realtime/business-inputs', async (request) => {
    const query = (request.query || {}) as { game?: string; date_key?: string };
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const dateKey = String(query.date_key || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return { ok: false, code: 'INVALID_DATE', error: 'date_key 必须是 YYYY-MM-DD' };
    }
    const deleted = await removeBusinessDailyInput(gameKey, dateKey);
    return { ok: true, deleted };
  });

  // 广告错误明细 Top N：按 (scene, ad_type, err_code, err_msg) 聚合，
  // 用于一眼定位「单事故」（top 1 集中爆发）vs「常态拒填」（1004 / no advertisement 分布）。
  // SDK 双发 bug 修复后，err_code 列里 -100/-101 是 SDK 自定义码，其它都是 wx 真实码。
  app.get('/api/realtime/ad-errors', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery & { limit?: string };
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
    const rows = await listAdErrorTopN(gameKey, fromTs, toTs, limit);
    const totalErrors = rows.reduce((s, r) => s + r.count, 0);
    return {
      ok: true,
      query: {
        game_key: gameKey,
        from: tsToBucket(fromTs),
        to: tsToBucket(toTs),
        window_minutes: windowMinutes,
        limit,
      },
      total_errors: totalErrors,
      errors: rows,
    };
  });

  // 通用分享传播数据：只统计 share_app_message「发起分享」，不声称真实回流。
  app.get('/api/realtime/share', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const fromBucket = tsToBucket(fromTs);
    const toBucket = tsToBucket(toTs);
    const result = await getShareOverview(gameKey, fromTs, toTs);
    return {
      ok: true,
      query: { game_key: gameKey, from: fromBucket, to: toBucket, window_minutes: windowMinutes },
      ...result,
    };
  });

  // 原始事件浏览（dashboard「原始事件」Tab 用）
  // - 共用 from/to/window 入参，跟随顶部全局时间窗口
  // - 支持按 event_name 精确过滤、按 user_id/anonymous_id 模糊搜索
  // - 分页返回，单次最多 500 条避免过载
  app.get('/api/realtime/events', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery & {
      event_name?: string;
      user_query?: string;
      limit?: string;
      offset?: string;
    };
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const { fromTs, toTs } = parseTimeRange(query);
    const limit = Math.max(1, Math.min(500, Number(query.limit) || 50));
    const offset = Math.max(0, Number(query.offset) || 0);
    const eventName = (query.event_name || '').trim() || undefined;
    const userQuery = (query.user_query || '').trim() || undefined;

    const { rows, total } = await listEvents({
      gameKey,
      fromTs,
      toTs,
      eventName,
      userQuery,
      limit,
      offset,
    });
    return {
      ok: true,
      query: {
        game_key: gameKey,
        from: tsToBucket(fromTs),
        to: tsToBucket(toTs),
        event_name: eventName || null,
        user_query: userQuery || null,
        limit,
        offset,
      },
      total,
      events: rows,
    };
  });

  // 列出某游戏当前时间窗口内出现过的事件名（供前端筛选下拉用）
  app.get('/api/realtime/event-names', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const { fromTs, toTs } = parseTimeRange(query);
    const names = await listEventNames(gameKey, fromTs, toTs);
    return { ok: true, names };
  });

  // hot-pot 专属：关卡分布 / 通关失败趋势
  // 路径有意写成 hotpot-progress，强调这是游戏独立指标，不要被其他游戏复用
  app.get('/api/realtime/hotpot-progress', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'hotpot';
    if (gameKey !== 'hotpot') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'hotpot-progress 当前只服务 hotpot' };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const fromBucket = tsToBucket(fromTs);
    const toBucket = tsToBucket(toTs);

    const result = await getProgressOverview(gameKey, fromTs, toTs);
    return {
      ok: true,
      query: { game_key: gameKey, from: fromBucket, to: toBucket, window_minutes: windowMinutes },
      kpi: result.kpi,
      distribution: result.distribution,
      series: result.series,
    };
  });

  // hot-pot 专属：果切挑战玩法看板（开始/结束/复活/道具/档位）
  app.get('/api/realtime/hotpot-fruit-slice', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'hotpot';
    if (gameKey !== 'hotpot') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'hotpot-fruit-slice 当前只服务 hotpot' };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const result = await getHotpotFruitSliceOverview(gameKey, fromTs, toTs);
    return {
      ok: true,
      query: { game_key: gameKey, from: tsToBucket(fromTs), to: tsToBucket(toTs), window_minutes: windowMinutes },
      ...result,
    };
  });

  // hot-pot 专属：每日限定玩法看板（挑战完成率/失败原因/道具/解锁）
  app.get('/api/realtime/hotpot-daily-limited', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'hotpot';
    if (gameKey !== 'hotpot') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'hotpot-daily-limited 当前只服务 hotpot' };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const result = await getHotpotDailyLimitedOverview(gameKey, fromTs, toTs);
    return {
      ok: true,
      query: { game_key: gameKey, from: tsToBucket(fromTs), to: tsToBucket(toTs), window_minutes: windowMinutes },
      ...result,
    };
  });

  // ============================================================
  // 花花妙屋专属玩法看板（4 个面板，路径前缀 huahua-）
  // 与 hotpot-progress 同样按游戏锁定，避免被其他游戏误用
  // ============================================================

  /** 花花经济流转：花愿/钻石入账出账渠道分布 + 净流时间序列 */
  app.get('/api/realtime/huahua-economy', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'huahua';
    if (gameKey !== 'huahua') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'huahua-economy 当前只服务 huahua' };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const result = await getHuahuaEconomyOverview(gameKey, fromTs, toTs);
    return {
      ok: true,
      query: {
        game_key: gameKey,
        from: tsToBucket(fromTs),
        to: tsToBucket(toTs),
        window_minutes: windowMinutes,
      },
      ...result,
    };
  });

  /** 花花订单转化：spawn → deliver 漏斗 + 按 tier 分布 */
  app.get('/api/realtime/huahua-order', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'huahua';
    if (gameKey !== 'huahua') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'huahua-order 当前只服务 huahua' };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const result = await getHuahuaOrderOverview(gameKey, fromTs, toTs);
    return {
      ok: true,
      query: {
        game_key: gameKey,
        from: tsToBucket(fromTs),
        to: tsToBucket(toTs),
        window_minutes: windowMinutes,
      },
      ...result,
    };
  });

  /** 花花成长 + 引导：星级升级分布 + tutorial_step 漏斗 */
  app.get('/api/realtime/huahua-growth', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'huahua';
    if (gameKey !== 'huahua') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'huahua-growth 当前只服务 huahua' };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const result = await getHuahuaGrowthOverview(gameKey, fromTs, toTs);
    return {
      ok: true,
      query: {
        game_key: gameKey,
        from: tsToBucket(fromTs),
        to: tsToBucket(toTs),
        window_minutes: windowMinutes,
      },
      ...result,
    };
  });

  /** 花花参与度：日常任务 / 周里程碑 / 签到 / 抽奖 / 熟客卡 / 合成 / 图鉴 */
  app.get('/api/realtime/huahua-engagement', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'huahua';
    if (gameKey !== 'huahua') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'huahua-engagement 当前只服务 huahua' };
    }
    const { fromTs, toTs, windowMinutes } = parseTimeRange(query);
    const result = await getHuahuaEngagementOverview(gameKey, fromTs, toTs);
    return {
      ok: true,
      query: {
        game_key: gameKey,
        from: tsToBucket(fromTs),
        to: tsToBucket(toTs),
        window_minutes: windowMinutes,
      },
      ...result,
    };
  });

  // ============================================================
  // 玩家档案快照（每天 1 次全量拉取，独立于 5 分钟事件流）
  // GET 看板查询 + POST 手动触发，先做 huahua，后续 hot-pot 同模式
  // ============================================================

  /**
   * 玩家档案快照分析：默认查最新 snapshot_date 的横切面 + 最近 30 天每日趋势。
   * 与 5 分钟事件流互补：事件流看"做了什么"，快照看"现在是什么状态"。
   */
  app.get('/api/realtime/huahua-snapshot', async (request) => {
    const query = (request.query || {}) as { game?: string; date?: string };
    const gameKey = query.game || 'huahua';
    if (gameKey !== 'huahua') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'huahua-snapshot 当前只服务 huahua' };
    }
    const result = await getHuahuaSnapshotOverview(gameKey, query.date);
    return { ok: true, ...result };
  });

  /**
   * 玩家明细分页查询：服务端排序 + 筛选 + 关键字搜索。
   *
   * Query params:
   *   game (default 'huahua')
   *   date YYYY-MM-DD（不传 = 最新一次拉到的快照日期）
   *   sort  排序字段（白名单见 SORTABLE_COLUMNS）
   *   order asc / desc（默认 desc）
   *   page  页码（默认 1）
   *   pageSize  每页（默认 50，上限 200）
   *   q     user_id 子串模糊搜索
   *   platform   平台前缀（wx / h5 / dy / anon）
   *   tutorialCompleted  0 / 1
   *   minLevel / maxLevel / minHuayuan  数值过滤
   */
  app.get('/api/realtime/huahua-snapshot/players', async (request) => {
    const query = (request.query || {}) as {
      game?: string;
      date?: string;
      sort?: string;
      order?: string;
      page?: string;
      pageSize?: string;
      q?: string;
      platform?: string;
      tutorialCompleted?: string;
      minLevel?: string;
      maxLevel?: string;
      minHuayuan?: string;
    };
    const gameKey = query.game || 'huahua';
    if (gameKey !== 'huahua') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'huahua-snapshot/players 当前只服务 huahua' };
    }
    const tutorialCompletedNum = query.tutorialCompleted !== undefined ? Number(query.tutorialCompleted) : NaN;
    const result = await listHuahuaPlayerSnapshots(gameKey, {
      snapshot_date: query.date,
      sort: query.sort,
      order: query.order === 'asc' ? 'asc' : 'desc',
      page: query.page ? Number(query.page) : undefined,
      page_size: query.pageSize ? Number(query.pageSize) : undefined,
      user_id_search: query.q,
      platform: query.platform,
      tutorial_completed:
        tutorialCompletedNum === 0 || tutorialCompletedNum === 1 ? (tutorialCompletedNum as 0 | 1) : undefined,
      min_level: query.minLevel ? Number(query.minLevel) : undefined,
      max_level: query.maxLevel ? Number(query.maxLevel) : undefined,
      min_huayuan: query.minHuayuan ? Number(query.minHuayuan) : undefined,
    });
    return { ok: true, ...result };
  });

  /**
   * 手动触发一次全量快照拉取（联调和数据修正用）；正常生产由 cron 每天 04:00 自动跑。
   * body: { game: 'huahua', retentionDays?: 30 }
   */
  app.post('/api/realtime/snapshot-now', async (request) => {
    const body = (request.body || {}) as { game?: string; retentionDays?: number };
    const gameKey = body.game || 'huahua';
    if (gameKey !== 'huahua') {
      return { ok: false, code: 'UNSUPPORTED_GAME', error: 'snapshot-now 当前只支持 huahua' };
    }
    const retentionDays =
      typeof body.retentionDays === 'number' && body.retentionDays > 0 ? body.retentionDays : undefined;
    const result = await ingestHuahuaSnapshots({ triggerSource: 'manual', retentionDays });
    return result;
  });
}

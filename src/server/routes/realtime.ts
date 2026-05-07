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
  listRecentIngestRuns,
  type AdMinuteRow,
} from '../analytics-db';
import { ingestEventsByGameKey } from '../jobs/ingest-events';
import { recomputeRealtimeAdMinute } from '../metrics/realtime-ad';
import { getOverview } from '../metrics/realtime-overview';
import { getProgressOverview } from '../metrics/realtime-progress';
import { BUCKET_SIZE_MS, BUCKET_SIZE_MINUTES, bucketToTs, tsToBucket } from '../metrics/bucket';

const DEFAULT_WINDOW_MINUTES = 60;

interface AdRevenueQuery {
  game?: string;
  from?: string;
  to?: string;
  window?: string;
}

interface AdRevenueSeriesItem {
  minute: string;
  ad_request_cnt: number;
  ad_show_cnt: number;
  ad_click_cnt: number;
  ad_complete_cnt: number;
  ad_error_cnt: number;
  ad_revenue_estimated_cny: number;
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
}

interface AdRevenueBreakdown {
  ad_type: string;
  scene: string;
  ad_show_cnt: number;
  ad_click_cnt: number;
  ad_complete_cnt: number;
  ad_revenue_estimated_cny: number;
}

interface AdRevenueResponse {
  ok: true;
  estimated: true;
  notice: string;
  query: { game_key: string; from: string; to: string; window_minutes: number };
  summary: AdRevenueSummary;
  series: AdRevenueSeriesItem[];
  breakdown_by_scene: AdRevenueBreakdown[];
}

function buildContinuousSeries(
  rows: AdMinuteRow[],
  fromBucket: string,
  toBucket: string,
): AdRevenueSeriesItem[] {
  const map = new Map<string, AdRevenueSeriesItem>();
  for (const row of rows) {
    const item = map.get(row.minute_bucket) || {
      minute: row.minute_bucket,
      ad_request_cnt: 0,
      ad_show_cnt: 0,
      ad_click_cnt: 0,
      ad_complete_cnt: 0,
      ad_error_cnt: 0,
      ad_revenue_estimated_cny: 0,
    };
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
    series.push(map.get(m) || {
      minute: m,
      ad_request_cnt: 0,
      ad_show_cnt: 0,
      ad_click_cnt: 0,
      ad_complete_cnt: 0,
      ad_error_cnt: 0,
      ad_revenue_estimated_cny: 0,
    });
  }
  return series;
}

function buildBreakdown(rows: AdMinuteRow[]): AdRevenueBreakdown[] {
  const map = new Map<string, AdRevenueBreakdown>();
  for (const row of rows) {
    const key = `${row.ad_type}|${row.scene}`;
    const item = map.get(key) || {
      ad_type: row.ad_type,
      scene: row.scene,
      ad_show_cnt: 0,
      ad_click_cnt: 0,
      ad_complete_cnt: 0,
      ad_revenue_estimated_cny: 0,
    };
    item.ad_show_cnt += row.ad_show_cnt;
    item.ad_click_cnt += row.ad_click_cnt;
    item.ad_complete_cnt += row.ad_complete_cnt;
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

    const windowMinutes = Math.max(5, Math.min(24 * 60, Number(query.window) || DEFAULT_WINDOW_MINUTES));
    const nowTs = Date.now();
    const fromTs = query.from ? bucketToTs(query.from) : nowTs - windowMinutes * 60_000;
    const toTs = query.to ? bucketToTs(query.to) : nowTs;
    // bucket 字符串严格落在 5 分钟整点；前端 X 轴据此渲染，不会再出现 1 分钟假刻度
    const fromMinute = tsToBucket(fromTs);
    const toMinute = tsToBucket(toTs);

    const rows = await listAdMinute(gameKey, fromMinute, toMinute);
    const series = buildContinuousSeries(rows, fromMinute, toMinute);
    const breakdown = buildBreakdown(rows);

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

    const response: AdRevenueResponse = {
      ok: true,
      estimated: true,
      notice: '所有金额均为基于预估 eCPM 的估算值，并非真实结算收入；以微信流量主结算数据为准。',
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
      },
      series,
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

  // 通用看板数据：DAU / 当日新增 / 次留 / 7留 / 5 分钟桶活跃序列
  // 与 ad-revenue 共用 from/to/window 入参口径，前端可以并排查询
  app.get('/api/realtime/overview', async (request) => {
    const query = (request.query || {}) as AdRevenueQuery;
    const gameKey = query.game || 'hotpot';
    if (!findAnalyticsGame(gameKey)) {
      return { ok: false, code: 'UNKNOWN_GAME', error: `unknown game: ${gameKey}` };
    }
    const windowMinutes = Math.max(5, Math.min(24 * 60, Number(query.window) || DEFAULT_WINDOW_MINUTES));
    const nowTs = Date.now();
    const fromTs = query.from ? bucketToTs(query.from) : nowTs - windowMinutes * 60_000;
    const toTs = query.to ? bucketToTs(query.to) : nowTs;
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
    const windowMinutes = Math.max(5, Math.min(24 * 60, Number(query.window) || DEFAULT_WINDOW_MINUTES));
    const nowTs = Date.now();
    const fromTs = query.from ? bucketToTs(query.from) : nowTs - windowMinutes * 60_000;
    const toTs = query.to ? bucketToTs(query.to) : nowTs;
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
    const windowMinutes = Math.max(5, Math.min(24 * 60, Number(query.window) || DEFAULT_WINDOW_MINUTES));
    const nowTs = Date.now();
    const fromTs = query.from ? bucketToTs(query.from) : nowTs - windowMinutes * 60_000;
    const toTs = query.to ? bucketToTs(query.to) : nowTs;
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
    const windowMinutes = Math.max(5, Math.min(24 * 60, Number(query.window) || DEFAULT_WINDOW_MINUTES));
    const nowTs = Date.now();
    const fromTs = query.from ? bucketToTs(query.from) : nowTs - windowMinutes * 60_000;
    const toTs = query.to ? bucketToTs(query.to) : nowTs;
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
}

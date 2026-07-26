import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Result,
  Row,
  Space,
  Statistic,
  Tooltip,
  Typography,
  message,
} from 'antd';
import ReactECharts from 'echarts-for-react';

import { getGameDescriptor } from '../../shared/games';
import { appendPlatformQuery } from '../../shared/platforms';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { fetchJson } from '../fetchJson';
import { RealtimeAdRevenue } from '../RealtimeAdRevenue';
import { RealtimeShare } from '../RealtimeShare';
import { buildWindowQuery, resolveWindow, tsToUtcBucketStr, type WindowValue } from '../timeWindow';

const { Text } = Typography;

interface OverviewKpi {
  dau: number;
  active_users_1h: number;
  new_users_today: number;
  retention_d1_rate: number | null;
  /** 分母：D-1 cohort（锚点前 1 日去重数） */
  retention_d1_cohort: number;
  /** 分子：cohort 中锚点日仍有 session_start 的去重数 */
  retention_d1_returned: number;
  /** D-1 cohort 所在本地日期 YYYY-MM-DD */
  retention_d1_cohort_date?: string;
  retention_d7_rate: number | null;
  retention_d7_cohort: number;
  retention_d7_returned: number;
  retention_d7_cohort_date?: string;
  /** 留存锚点日（= 当前时间窗口结束日所在自然日） */
  retention_anchor_date?: string;
  computed_at: number;
}

interface OverviewSeriesPoint {
  bucket: string;
  ts: number;
  active_users: number;
  new_users: number;
}

interface OverviewResponse {
  ok: boolean;
  query?: { game_key: string; from: string; to: string; window_minutes: number };
  kpi?: OverviewKpi;
  series?: OverviewSeriesPoint[];
  code?: string;
  error?: string;
}

/**
 * KPI 区只用 ad-revenue 接口的 total_revenue_estimated_cny；同窗口下与 RealtimeAdRevenue 子组件
 * 各自 fetch 一次，浏览器/上游 cache 命中率高，重复成本可控
 */
interface AdSummaryLiteResponse {
  ok: boolean;
  summary?: {
    total_revenue_estimated_cny?: number;
    ad_penetration_rate?: number;
    ad_show_per_uu?: number;
    fill_rate?: number;
  };
  code?: string;
  error?: string;
}

interface AcquisitionCostResponse {
  ok: boolean;
  total_spend_cny?: number;
  rows?: number;
  source?: string;
  error?: string;
  code?: string;
}

interface BusinessRoiLiteRow {
  date_key: string;
  spend_cny: number;
  game_new_users: number;
  cpi_cny: number | null;
  d3_ltv_cny: number | null;
  d3_roi: number | null;
  d7_ltv_cny: number | null;
  d7_roi: number | null;
  data_status_label: string;
}

interface BusinessRoiLiteResponse {
  ok: boolean;
  rows?: BusinessRoiLiteRow[];
  code?: string;
  error?: string;
}

function formatRetentionRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return (value * 100).toFixed(1);
}

function formatRetentionFraction(
  cohortDate: string | undefined,
  anchorDate: string | undefined,
  returned: number | undefined,
  cohort: number | undefined,
): string {
  // 分母是「新增 cohort」（首次 session_start），不是当日活跃；文案勿写成「活跃」以免和 DAU 对不上
  const cohortLabel = cohortDate ? `${cohortDate} 新增` : 'cohort';
  const anchorLabel = anchorDate ? `${anchorDate} 回访` : '锚点日回访';
  if (cohort === undefined || cohort === 0) return `${cohortLabel} 0 人，暂无样本`;
  return `${cohortLabel} ${cohort} 人 → ${anchorLabel} ${returned ?? 0} 人`;
}

function buildShiftedWindowQuery(window: WindowValue, shiftMs: number): string {
  const { fromTs, toTs } = resolveWindow(window);
  return `from=${encodeURIComponent(tsToUtcBucketStr(fromTs + shiftMs))}&to=${encodeURIComponent(tsToUtcBucketStr(toTs + shiftMs))}`;
}

function dateKey(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDaysDateKey(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateKey(date.getTime());
}

function buildDateRangeQuery(window: WindowValue, shiftMs = 0): string {
  const { fromTs, toTs } = resolveWindow(window);
  return `from_date=${encodeURIComponent(dateKey(fromTs + shiftMs))}&to_date=${encodeURIComponent(dateKey(toTs + shiftMs))}`;
}

function deltaText(current: number | null | undefined, previous: number | null | undefined, options: {
  digits?: number;
  reverseGood?: boolean;
  unavailableText?: string;
} = {}): { text: string; color?: string } {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return { text: options.unavailableText || '较昨日同期 -' };
  }
  if (previous === 0) {
    return { text: current === 0 ? '较昨日 0.0%' : '昨日为 0，无法算涨跌' };
  }
  const diff = ((current - previous) / Math.abs(previous)) * 100;
  const sign = diff > 0 ? '+' : '';
  const digits = options.digits ?? 0;
  const isGood = options.reverseGood ? diff < 0 : diff > 0;
  const color = diff === 0 ? undefined : isGood ? '#16a34a' : '#dc2626';
  return {
    text: `较昨日同期 ${sign}${diff.toFixed(digits)}%`,
    color,
  };
}

function rateDeltaText(current: number | null | undefined, previous: number | null | undefined): { text: string; color?: string } {
  if (current === null || current === undefined || previous === null || previous === undefined) {
    return { text: '较昨日同期 -' };
  }
  return deltaText(current, previous, { digits: 1 });
}

function KpiDeltaText({ delta }: { delta: { text: string; color?: string } }) {
  return <Text type={delta.color ? undefined : 'secondary'} style={delta.color ? { color: delta.color } : undefined}>{delta.text}</Text>;
}

/** 7 张 KPI 卡片共用容器样式：同高 + 统一 padding，避免"次留多一行副标题"造成的高度抖动 */
const kpiCardStyle = { width: '100%', height: '100%' } as const;
const kpiCardStyles = {
  body: {
    minHeight: 110,
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'space-between' as const,
  },
};

/**
 * 5 分钟桶字符串转本地时区标签（与 RealtimeAdRevenue.formatMinuteLabel 同款）。
 * 后端 tsToBucket 给的是 UTC 字符串（"YYYY-MM-DDTHH:mm" + 隐含 Z），直接 slice 显示出来是 UTC，
 * 北京用户会看到偏移 8 小时的奇怪刻度，这里转回本地。
 */
function bucketShort(bucket: string): string {
  if (!bucket) return '';
  const utcDate = new Date(`${bucket}:00.000Z`);
  if (isNaN(utcDate.getTime())) return bucket;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(utcDate.getMonth() + 1)}-${pad(utcDate.getDate())} ${pad(utcDate.getHours())}:${pad(utcDate.getMinutes())}`;
}

function yuan(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '-';
  return `${value.toFixed(digits)} 元`;
}

/**
 * 大盘运营页面 = 通用 KPI + 活跃/新增趋势 + 广告变现 + 分享传播。
 *
 * 这里只展示对所有游戏一致的"经营大盘"指标，游戏专属玩法（关卡漏斗/任务漏斗等）
 * 在 /business/gameplay 单独承载。这样所有游戏的大盘视图视觉对齐、产品决策口径一致。
 */
export function DashboardPage() {
  const {
    gameKey,
    platform,
    windowSel,
    refreshToken,
    setLoading,
    setLastRefreshedAt,
  } = useAnalyticsFilter();

  const gameDescriptor = getGameDescriptor(gameKey);
  const isIntegrated = gameDescriptor?.hasAnalyticsSdk === true;

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [adSummary, setAdSummary] = useState<AdSummaryLiteResponse | null>(null);
  const [acquisitionCost, setAcquisitionCost] = useState<AcquisitionCostResponse | null>(null);
  const [comparison, setComparison] = useState<{ overview: OverviewResponse | null; ad: AdSummaryLiteResponse | null }>({
    overview: null,
    ad: null,
  });
  const [comparisonCost, setComparisonCost] = useState<AcquisitionCostResponse | null>(null);
  const [businessRoi, setBusinessRoi] = useState<BusinessRoiLiteResponse | null>(null);
  const requestSeqRef = useRef(0);

  const loadAll = useCallback(
    async (nextGameKey: string, nextWindow: WindowValue) => {
      const desc = getGameDescriptor(nextGameKey);
      if (!desc?.hasAnalyticsSdk) {
        setOverview(null);
        setAdSummary(null);
        setAcquisitionCost(null);
        setComparison({ overview: null, ad: null });
        setComparisonCost(null);
        setBusinessRoi(null);
        setLastRefreshedAt(Date.now());
        return;
      }
      const seq = ++requestSeqRef.current;
      setLoading(true);
      try {
        const queryStr = appendPlatformQuery(buildWindowQuery(nextWindow), platform);
        const overviewPromise = fetchJson<OverviewResponse>(
          `/api/realtime/overview?game=${encodeURIComponent(nextGameKey)}&${queryStr}`,
        );
        const adSummaryPromise = fetchJson<AdSummaryLiteResponse>(
          `/api/realtime/ad-revenue?game=${encodeURIComponent(nextGameKey)}&${queryStr}`,
        );
        const costPromise = fetchJson<AcquisitionCostResponse>(
          `/api/realtime/acquisition-cost?game=${encodeURIComponent(nextGameKey)}&${appendPlatformQuery(buildDateRangeQuery(nextWindow), platform)}`,
        );
        const compareQueryStr = appendPlatformQuery(
          buildShiftedWindowQuery(nextWindow, -86_400_000),
          platform,
        );
        const compareOverviewPromise = fetchJson<OverviewResponse>(
          `/api/realtime/overview?game=${encodeURIComponent(nextGameKey)}&${compareQueryStr}`,
        );
        const compareAdSummaryPromise = fetchJson<AdSummaryLiteResponse>(
          `/api/realtime/ad-revenue?game=${encodeURIComponent(nextGameKey)}&${compareQueryStr}`,
        );
        const compareCostPromise = fetchJson<AcquisitionCostResponse>(
          `/api/realtime/acquisition-cost?game=${encodeURIComponent(nextGameKey)}&${appendPlatformQuery(buildDateRangeQuery(nextWindow, -86_400_000), platform)}`,
        );
        // D3 ROI 只展示已经完整出数的 cohort：cohort 日 + 3 天必须已经结束。
        const roiToDate = addDaysDateKey(dateKey(Date.now()), -4);
        const roiFromDate = addDaysDateKey(roiToDate, -30);
        const businessRoiPromise = fetchJson<BusinessRoiLiteResponse>(
          `/api/realtime/business-inputs?game=${encodeURIComponent(nextGameKey)}&${appendPlatformQuery(`from_date=${encodeURIComponent(roiFromDate)}&to_date=${encodeURIComponent(roiToDate)}`, platform)}`,
        );
        const [
          ovRes,
          adRes,
          costRes,
          compareOvRes,
          compareAdRes,
          compareCostRes,
          businessRoiRes,
        ] = await Promise.all([
          overviewPromise,
          adSummaryPromise,
          costPromise,
          compareOverviewPromise,
          compareAdSummaryPromise,
          compareCostPromise,
          businessRoiPromise,
        ]);
        // 防止竞态：仅最新一次请求结果生效
        if (seq !== requestSeqRef.current) return;
        if (!ovRes.ok) {
          message.error(`获取 overview 失败: ${ovRes.error || ovRes.code}`);
        }
        setOverview(ovRes);
        setAdSummary(adRes);
        setAcquisitionCost(costRes);
        setComparison({
          overview: compareOvRes.ok ? compareOvRes : null,
          ad: compareAdRes.ok ? compareAdRes : null,
        });
        setComparisonCost(compareCostRes);
        setBusinessRoi(businessRoiRes.ok ? businessRoiRes : null);
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        message.error(`加载大盘失败: ${String(error)}`);
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [platform, setLoading, setLastRefreshedAt],
  );

  useEffect(() => {
    void loadAll(gameKey, windowSel);
  }, [gameKey, platform, windowSel, refreshToken, loadAll]);

  // 活跃 / 新增双线（5 分钟桶）
  const activeChartOption = useMemo(() => {
    const series = overview?.series || [];
    const xAxis = series.map((p) => bucketShort(p.bucket));
    // 5 分钟桶 1 小时 = 12 桶；今日窗口最多 ~288 桶。
    // 默认 zoom 到最近 60 桶（约 5 小时）避免标签过密；用户拖 slider 查看全天
    const zoomStart = series.length > 60 ? Math.max(0, 100 - (60 / series.length) * 100) : 0;
    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['活跃用户', '新增用户'],
        textStyle: { color: '#374151', fontSize: 13, fontWeight: 500 },
      },
      grid: { left: 50, right: 30, top: 50, bottom: 60 },
      xAxis: {
        type: 'category',
        data: xAxis,
        axisLabel: { hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        name: '人数',
        minInterval: 1,
      },
      dataZoom: [
        { type: 'inside', start: zoomStart, end: 100 },
        { type: 'slider', height: 18, bottom: 10, start: zoomStart, end: 100 },
      ],
      series: [
        {
          name: '活跃用户',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#3b82f6', borderRadius: [4, 4, 0, 0] },
          data: series.map((p) => p.active_users),
        },
        {
          name: '新增用户',
          type: 'line',
          smooth: true,
          symbolSize: 6,
          itemStyle: { color: '#f59e0b' },
          areaStyle: { opacity: 0.15 },
          data: series.map((p) => p.new_users),
        },
      ],
    };
  }, [overview?.series]);

  const recentD3RoiRows = useMemo(
    () => (businessRoi?.rows || [])
      .filter((row) => row.d3_ltv_cny !== null)
      .sort((a, b) => a.date_key.localeCompare(b.date_key))
      .slice(-3),
    [businessRoi?.rows],
  );
  const recentD7RoiRows = useMemo(
    () => (businessRoi?.rows || [])
      .filter((row) => row.d7_ltv_cny !== null)
      .sort((a, b) => a.date_key.localeCompare(b.date_key))
      .slice(-3),
    [businessRoi?.rows],
  );

  // 未接入 SDK 的游戏：拦截整页（不要让用户看到一堆 0 误以为"线上没人玩"）
  if (!isIntegrated) {
    return (
      <Result
        status="info"
        title={`${gameDescriptor?.displayName ?? gameKey} 暂未接入打点 SDK`}
        subTitle="该游戏还没有标准化的打点流水，dashboard 暂时无数据可展示。请先在游戏端接入 @gp/analytics-sdk。"
        extra={
          <Space orientation="vertical" size="small" align="start">
            <Text>
              接入步骤详见 <Text code>game-analysis/packages/analytics-sdk/README.md</Text>，约 30 分钟可完成。
            </Text>
            <Text type="secondary">
              关键步骤：① 项目内 import @gp/analytics-sdk → ② 注入 Platform Adapter（参考 hot-pot 写法） → ③
              启动尽早调用 <Text code>initAnalytics()</Text> → ④ 业务打点用 <Text code>analytics.track(...)</Text>。
            </Text>
            <Text type="secondary">
              接入完成后，把 <Text code>shared/games.ts</Text> 中本游戏的{' '}
              <Text code>hasAnalyticsSdk</Text> 翻 true，并把{' '}
              <Text code>server/config/analytics-games.ts</Text> 中的 <Text code>enabled</Text> 也翻
              true，cron 会自动开始拉取。
            </Text>
          </Space>
        }
      />
    );
  }

  const overviewKpi = overview?.kpi;
  const previousKpi = comparison.overview?.kpi;
  const currentAd = adSummary?.summary;
  const previousAd = comparison.ad?.summary;
  const currentSpend = acquisitionCost?.ok ? acquisitionCost.total_spend_cny : undefined;
  const previousSpend = comparisonCost?.ok ? comparisonCost.total_spend_cny : undefined;
  const acquisitionSource = acquisitionCost?.ok ? '腾讯广告实时' : `腾讯广告拉取失败：${acquisitionCost?.error || acquisitionCost?.code || '接口未返回'}`;
  const currentCpi =
    currentSpend !== undefined && overviewKpi?.new_users_today
      ? currentSpend / overviewKpi.new_users_today
      : null;
  const previousCpi =
    previousSpend !== undefined && previousKpi?.new_users_today
      ? previousSpend / previousKpi.new_users_today
      : null;

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        title="实时趋势 · 5 分钟粒度"
        description={
          <Space orientation="vertical" size={0}>
            <Text>
              数据来源：@gp/analytics-sdk 打点流水（analytics_events），cron 每 5 分钟增量拉取并聚合。
            </Text>
            <Text type="secondary">
              用户身份：优先 user_id（业务 openid），未登录时降级到 anonymous_id；活跃、新增、留存回访都用
              session_start 去重；本页展示的是新增留存：cohort=锚点日前 1/7 日首次 session_start 的新用户，
              retain=cohort 中锚点日再次进入游戏的去重数。活跃次留另指“前一日活跃用户次日仍活跃”，不等同新增次留。
            </Text>
          </Space>
        }
      />

      <Row gutter={[16, 16]} align="stretch">
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="当前时间窗口内有 session_start 事件的去重用户数。窗口=今日时即为今日 DAU；选历史日时即为该日 DAU；多日窗口为窗口内活跃合计。">
              <Statistic title="窗口活跃" value={overviewKpi?.dau ?? 0} suffix="人" />
            </Tooltip>
            <KpiDeltaText delta={deltaText(overviewKpi?.dau, previousKpi?.dau, { digits: 1 })} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="窗口结束时刻向前 1 小时内任意事件的去重用户数。窗口=today 时与“现在”重合；历史窗口看的是该窗口结束前最后 1 小时。">
              <Statistic
                title="近 1 小时活跃"
                value={overviewKpi?.active_users_1h ?? 0}
                suffix="人"
              />
            </Tooltip>
            <KpiDeltaText delta={deltaText(overviewKpi?.active_users_1h, previousKpi?.active_users_1h, { digits: 1 })} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="在全表中首次 session_start 于当前时间窗口内的去重用户数。">
              <Statistic title="窗口内新增" value={overviewKpi?.new_users_today ?? 0} suffix="人" />
            </Tooltip>
            <KpiDeltaText delta={deltaText(overviewKpi?.new_users_today, previousKpi?.new_users_today, { digits: 1 })} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="锚点日 = 当前时间窗口结束日所在自然日。D1 新增次留 = 锚点日前 1 日新增 cohort 中、在锚点日仍有 session_start 的比例。活跃次留是“前一日活跃用户次日仍活跃”，这里不展示。窗口切到 5/8 一整天时即为 5/7 新用户 → 5/8 回访。">
              <Statistic
                title="D1 新增次留"
                value={formatRetentionRate(overviewKpi?.retention_d1_rate)}
                suffix={overviewKpi?.retention_d1_rate ? '%' : ''}
              />
            </Tooltip>
            <Text type="secondary">
              {formatRetentionFraction(
                overviewKpi?.retention_d1_cohort_date,
                overviewKpi?.retention_anchor_date,
                overviewKpi?.retention_d1_returned,
                overviewKpi?.retention_d1_cohort,
              )}
            </Text>
            <KpiDeltaText delta={rateDeltaText(overviewKpi?.retention_d1_rate, previousKpi?.retention_d1_rate)} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="7 留 D7 = 锚点日前 7 日新增 cohort 中、在锚点日仍有 session_start 的比例。打点不足 7 天时 cohort 为 0。">
              <Statistic
                title="7 留 D7"
                value={formatRetentionRate(overviewKpi?.retention_d7_rate)}
                suffix={overviewKpi?.retention_d7_rate ? '%' : ''}
              />
            </Tooltip>
            <Text type="secondary">
              {formatRetentionFraction(
                overviewKpi?.retention_d7_cohort_date,
                overviewKpi?.retention_anchor_date,
                overviewKpi?.retention_d7_returned,
                overviewKpi?.retention_d7_cohort,
              )}
            </Text>
            <KpiDeltaText delta={rateDeltaText(overviewKpi?.retention_d7_rate, previousKpi?.retention_d7_rate)} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Statistic
              title="计算时刻"
              value={
                overviewKpi?.computed_at
                  ? new Date(overviewKpi.computed_at).toLocaleTimeString('zh-CN')
                  : '-'
              }
            />
            <Text type="secondary">{overview?.query?.from?.slice(0, 10) || '-'}</Text>
          </Card>
        </Col>
        <Col span={24}>
          <Card
            title="投放与商业化波动（同时间段 vs 昨日）"
            extra={<Text type="secondary">投放消耗优先走腾讯广告实时接口；接口未生效时回退到已补录经营数据。</Text>}
          >
            <Row gutter={[16, 16]}>
              <Col xs={12} md={4}>
                <Statistic title="投放消耗" value={currentSpend ?? '-'} suffix={currentSpend === undefined ? undefined : '元'} precision={2} />
                <KpiDeltaText delta={deltaText(currentSpend, previousSpend, { digits: 1, unavailableText: acquisitionSource })} />
              </Col>
              <Col xs={12} md={4}>
                <Statistic title="投放 CPI" value={currentCpi ?? '-'} suffix={currentCpi === null ? undefined : '元'} precision={4} />
                <KpiDeltaText delta={deltaText(currentCpi, previousCpi, { digits: 1, reverseGood: true, unavailableText: acquisitionSource })} />
              </Col>
              <Col xs={12} md={4}>
                <Statistic title="广告渗透" value={currentAd?.ad_penetration_rate ?? 0} suffix="%" precision={1} />
                <KpiDeltaText delta={deltaText(currentAd?.ad_penetration_rate, previousAd?.ad_penetration_rate, { digits: 1 })} />
              </Col>
              <Col xs={12} md={4}>
                <Statistic title="人均广告展示" value={currentAd?.ad_show_per_uu ?? 0} suffix="次" precision={2} />
                <KpiDeltaText delta={deltaText(currentAd?.ad_show_per_uu, previousAd?.ad_show_per_uu, { digits: 1 })} />
              </Col>
              <Col xs={12} md={4}>
                <Statistic title="填充率" value={currentAd?.fill_rate ?? 0} suffix="%" precision={1} />
                <KpiDeltaText delta={deltaText(currentAd?.fill_rate, previousAd?.fill_rate, { digits: 1 })} />
              </Col>
              <Col xs={12} md={4}>
                <Statistic title="广告收益" value={currentAd?.total_revenue_estimated_cny ?? 0} suffix="元" precision={2} />
                <KpiDeltaText
                  delta={deltaText(currentAd?.total_revenue_estimated_cny, previousAd?.total_revenue_estimated_cny, {
                    digits: 1,
                  })}
                />
              </Col>
            </Row>
            <div style={{ marginTop: 16, marginBottom: 8 }}>
              <Text strong>最近 3 个已出数投放日 D3 ROI</Text>
              <Text type="secondary" style={{ marginLeft: 8 }}>未成熟日期不展示</Text>
            </div>
            <Row gutter={[12, 12]}>
              {recentD3RoiRows.length > 0 ? recentD3RoiRows.map((row) => (
                <Col xs={24} md={8} key={row.date_key}>
                  <Card size="small">
                    <Tooltip title="D3 ROI = 该日期新增 cohort 的 D3 累计 LTV / 当日 CPI；只使用已完整结束的 D3 数据。">
                      <Statistic
                        title={`${row.date_key.slice(5)} D3 ROI`}
                        value={row.d3_roi === null ? (row.spend_cny > 0 ? '-' : '未投放') : row.d3_roi * 100}
                        suffix={row.d3_roi === null ? undefined : '%'}
                        precision={1}
                      />
                    </Tooltip>
                    <Space orientation="vertical" size={0}>
                      <Text type="secondary">消耗 {yuan(row.spend_cny)}，新增 {row.game_new_users} 人</Text>
                      <Text type="secondary">
                        D3 LTV {yuan(row.d3_ltv_cny, 4)}，CPI {yuan(row.cpi_cny, 4)}
                      </Text>
                    </Space>
                  </Card>
                </Col>
              )) : (
                <Col span={24}>
                  <Text type="secondary">暂无可展示的已出数 D3 数据：需要有新增 cohort，并等待 D3 数据成熟。</Text>
                </Col>
              )}
            </Row>
            <div style={{ marginTop: 16, marginBottom: 8 }}>
              <Text strong>最近 3 个已出数日期 D7 ROI</Text>
              <Text type="secondary" style={{ marginLeft: 8 }}>未成熟日期不展示</Text>
            </div>
            <Row gutter={[12, 12]}>
              {recentD7RoiRows.length > 0 ? recentD7RoiRows.map((row) => (
                <Col xs={24} md={8} key={row.date_key}>
                  <Card size="small">
                    <Tooltip title="D7 ROI = 该日期新增 cohort 的 D7 累计 LTV / 当日 CPI；只使用已完整结束的 D7 数据。">
                      <Statistic
                        title={`${row.date_key.slice(5)} D7 ROI`}
                        value={row.d7_roi === null ? (row.spend_cny > 0 ? '-' : '未投放') : row.d7_roi * 100}
                        suffix={row.d7_roi === null ? undefined : '%'}
                        precision={1}
                      />
                    </Tooltip>
                    <Space orientation="vertical" size={0}>
                      <Text type="secondary">消耗 {yuan(row.spend_cny)}，新增 {row.game_new_users} 人</Text>
                      <Text type="secondary">
                        D7 LTV {yuan(row.d7_ltv_cny, 4)}，CPI {yuan(row.cpi_cny, 4)}
                      </Text>
                    </Space>
                  </Card>
                </Col>
              )) : (
                <Col span={24}>
                  <Text type="secondary">暂无可展示的已出数 D7 数据：需要有新增 cohort，并等待 D7 数据成熟。</Text>
                </Col>
              )}
            </Row>
          </Card>
        </Col>
        <Col span={24}>
          <Card title="活跃 / 新增趋势（5 分钟桶 · 当日）">
            {(overview?.series?.length || 0) > 0 ? (
              <ReactECharts option={activeChartOption} style={{ height: 320 }} />
            ) : (
              <Empty description="暂无打点数据，请确认游戏端已上报 session_start 事件" />
            )}
          </Card>
        </Col>
      </Row>

      <RealtimeAdRevenue fixedGameKey={gameKey} platform={platform} windowSel={windowSel} refreshToken={refreshToken} />
      <RealtimeShare fixedGameKey={gameKey} platform={platform} windowSel={windowSel} refreshToken={refreshToken} />
    </Space>
  );
}

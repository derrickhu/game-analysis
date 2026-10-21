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
import ReactECharts from '../components/AnalyticsChart';

import { getGameDescriptor } from '../../shared/games';
import { appendPlatformQuery } from '../../shared/platforms';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { fetchJson } from '../fetchJson';
import { RealtimeAdRevenue } from '../RealtimeAdRevenue';
import { RealtimeShare } from '../RealtimeShare';
import { PaybackSection } from './PaybackSection';
import { chartColors } from '../theme/chartPalette';
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
  minutes_per_user?: number;
  avg_session_ms?: number;
  median_session_ms?: number;
  session_cnt?: number;
  play_users?: number;
}

interface OverviewSeriesPoint {
  bucket: string;
  ts: number;
  active_users: number;
  new_users: number;
}

interface DurationHistogramBin {
  label: string;
  users: number;
}

interface OnlineCurvePoint {
  ts: number;
  label: string;
  online: number;
}

interface OnlineCurveResponse {
  ok: boolean;
  bucket_minutes?: number;
  live?: boolean;
  current?: number;
  peak?: number;
  peak_label?: string;
  points?: OnlineCurvePoint[];
  code?: string;
  error?: string;
}

interface OverviewResponse {
  ok: boolean;
  query?: { game_key: string; from: string; to: string; window_minutes: number };
  kpi?: OverviewKpi;
  series?: OverviewSeriesPoint[];
  duration_histogram?: DurationHistogramBin[];
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
    completion_rate?: number;
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
function clockOf(label: string): string {
  const time = label.includes(' ') ? label.split(' ').pop() || label : label;
  return time;
}

/** 5 分钟在线曲线刻度：整点里的偶数小时，再加上首尾。 */
function onlineAxisInterval(labels: string[]): (index: number) => boolean {
  const last = Math.max(0, labels.length - 1);
  return (index: number) => {
    if (index === 0 || index === last) return true;
    const [hour, minute] = clockOf(labels[index] || '').split(':');
    if (minute !== '00') return false;
    return Number(hour) % 2 === 0;
  };
}

function bucketShort(bucket: string): string {
  if (!bucket) return '';
  const utcDate = new Date(`${bucket}:00.000Z`);
  if (isNaN(utcDate.getTime())) return bucket;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(utcDate.getMonth() + 1)}-${pad(utcDate.getDate())} ${pad(utcDate.getHours())}:${pad(utcDate.getMinutes())}`;
}

/**
 * 大盘运营页面 = 通用 KPI + 留存回本 + 实时在线 + 活跃/新增趋势 + 广告变现 + 分享传播。
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
  const [onlineCurve, setOnlineCurve] = useState<OnlineCurveResponse | null>(null);
  const [onlineCompare, setOnlineCompare] = useState<OnlineCurveResponse | null>(null);
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
        setOnlineCurve(null);
        setOnlineCompare(null);
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
        const onlinePromise = fetchJson<OnlineCurveResponse>(
          `/api/realtime/online-curve?game=${encodeURIComponent(nextGameKey)}&${queryStr}`,
        );
        const onlineComparePromise = fetchJson<OnlineCurveResponse>(
          `/api/realtime/online-curve?game=${encodeURIComponent(nextGameKey)}&${compareQueryStr}`,
        );
        const [
          ovRes,
          adRes,
          costRes,
          compareOvRes,
          compareAdRes,
          compareCostRes,
          onlineRes,
          onlineCompareRes,
        ] = await Promise.all([
          overviewPromise,
          adSummaryPromise,
          costPromise,
          compareOverviewPromise,
          compareAdSummaryPromise,
          compareCostPromise,
          onlinePromise,
          onlineComparePromise,
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
        setOnlineCurve(onlineRes);
        setOnlineCompare(onlineCompareRes.ok ? onlineCompareRes : null);
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
  // 默认展示当前时间窗口全量（选「今天」= 自然日 00:00 ~ now），不截最近几小时。
  const activeChartOption = useMemo(() => {
    const series = overview?.series || [];
    const xAxis = series.map((p) => bucketShort(p.bucket));
    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['活跃用户', '新增用户'],
        textStyle: { fontSize: 13, fontWeight: 560 },
      },
      grid: { left: 16, right: 20, top: 52, bottom: 56, containLabel: true },
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
        { type: 'inside', start: 0, end: 100 },
        { type: 'slider', height: 20, bottom: 8, start: 0, end: 100 },
      ],
      series: [
        {
          name: '活跃用户',
          type: 'bar',
          barMaxWidth: 22,
          itemStyle: { color: chartColors.secondary, borderRadius: [6, 6, 2, 2] },
          data: series.map((p) => p.active_users),
        },
        {
          name: '新增用户',
          type: 'line',
          smooth: 0.35,
          symbolSize: 7,
          itemStyle: { color: chartColors.quaternary },
          lineStyle: { width: 2.75, color: chartColors.quaternary },
          areaStyle: { opacity: 0.22 },
          data: series.map((p) => p.new_users),
        },
      ],
    };
  }, [overview?.series]);

  const onlineChartOption = useMemo(() => {
    const points = onlineCurve?.points || [];
    const clocks = points.map((point) => clockOf(point.label));
    const clocksUnique = new Set(clocks).size === clocks.length;
    const fine = onlineCurve?.bucket_minutes === 5 && clocksUnique;
    const yesterday = fine ? onlineCompare?.points || [] : [];
    const yesterdayByClock = new Map(yesterday.map((point) => [clockOf(point.label), point.online]));
    const labels = points.map((point) => point.label);
    return {
      tooltip: { trigger: 'axis' as const },
      legend: {
        data: yesterday.length ? ['在线', '昨日同期'] : ['在线'],
        textStyle: { fontSize: 13, fontWeight: 560 },
      },
      grid: { left: 16, right: 20, top: 48, bottom: 16, containLabel: true },
      xAxis: {
        type: 'category' as const,
        data: labels,
        boundaryGap: false,
        axisLabel: {
          hideOverlap: true,
          interval: fine ? onlineAxisInterval(labels) : 0,
        },
      },
      yAxis: {
        type: 'value' as const,
        name: '人数',
        min: 0,
        minInterval: 1,
      },
      series: [
        {
          name: '在线',
          type: 'line' as const,
          smooth: 0.3,
          showSymbol: points.length <= 48,
          symbolSize: 6,
          z: 3,
          itemStyle: { color: chartColors.primary },
          lineStyle: { width: 2.5, color: chartColors.primary },
          areaStyle: { opacity: 0.14 },
          data: points.map((point) => point.online),
        },
        ...(yesterday.length
          ? [{
              name: '昨日同期',
              type: 'line' as const,
              smooth: 0.3,
              showSymbol: false,
              z: 2,
              itemStyle: { color: chartColors.muted },
              lineStyle: { width: 1.5, type: 'dashed' as const, color: chartColors.muted },
              data: points.map((point) => yesterdayByClock.get(clockOf(point.label)) ?? null),
            }]
          : []),
      ],
    };
  }, [onlineCompare?.points, onlineCurve?.bucket_minutes, onlineCurve?.points]);

  const durationHistogram = overview?.duration_histogram || [];
  const durationHistogramOption = useMemo(() => {
    const bins = durationHistogram;
    const crowded = bins.length > 24;
    return {
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        formatter: (params: unknown) => {
          const row = (Array.isArray(params) ? params[0] : params) as { name?: string; value?: number } | undefined;
          const label = String(row?.name ?? '');
          const users = Number(row?.value ?? 0);
          const minuteText = label === '<1' ? '不足 1 分钟' : `${label} 分钟`;
          return `${minuteText}<br/>${users.toLocaleString('zh-CN')} 人`;
        },
      },
      grid: { left: 12, right: 28, top: 36, bottom: crowded ? 52 : 24, containLabel: true },
      dataZoom: crowded
        ? [
            { type: 'inside' as const, start: 0, end: 100 },
            { type: 'slider' as const, height: 18, bottom: 8, start: 0, end: 100 },
          ]
        : [],
      xAxis: {
        type: 'category' as const,
        name: '分钟',
        nameTextStyle: { fontSize: 12, color: '#64748b' },
        data: bins.map((bin) => bin.label),
        axisLabel: { fontSize: 11 },
        axisTick: { alignWithLabel: true },
      },
      yAxis: {
        type: 'value' as const,
        name: '人数',
        minInterval: 1,
        nameTextStyle: { fontSize: 12, color: chartColors.tertiary },
        axisLabel: { fontSize: 11, color: chartColors.tertiary },
        splitLine: { lineStyle: { type: 'dashed' as const, opacity: 0.5 } },
      },
      series: [
        {
          name: '人数',
          type: 'bar' as const,
          barMaxWidth: 28,
          itemStyle: { color: chartColors.tertiary, borderRadius: [6, 6, 2, 2] },
          data: bins.map((bin) => bin.users),
        },
      ],
    };
  }, [durationHistogram]);

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

  const hasLoadedOverview = overview?.ok === true;
  const isEmptyKpi =
    hasLoadedOverview &&
    (overviewKpi?.dau ?? 0) === 0 &&
    (overviewKpi?.new_users_today ?? 0) === 0 &&
    (overviewKpi?.active_users_1h ?? 0) === 0;

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {isEmptyKpi && (
        <Alert
          type="warning"
          showIcon
          title={`当前筛选暂无活跃（${gameDescriptor?.displayName ?? gameKey} · ${platform}），可换游戏/渠道或点「立即拉取并刷新」`}
        />
      )}

      <Row gutter={[16, 16]} align="stretch">
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card className="kpi-card" style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="窗口内有 session_start 的去重用户数。选「今天」= 今日 DAU；多日窗口 = 窗口内活跃合计。身份优先 user_id，未登录用 anonymous_id。">
              <Statistic title="窗口活跃" value={overviewKpi?.dau ?? 0} suffix="人" />
            </Tooltip>
            <KpiDeltaText delta={deltaText(overviewKpi?.dau, previousKpi?.dau, { digits: 1 })} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card className="kpi-card" style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="窗口内拼出有效会话的人，人均在线分钟。全游戏同一口径：相邻事件间隔 ≤5 分钟算一次会话，短于 15 秒不计。不是 session_end.duration_ms。">
              <Statistic
                title="人均时长"
                value={overviewKpi?.minutes_per_user ?? 0}
                suffix="分钟"
                precision={1}
              />
            </Tooltip>
            <Text type="secondary">
              中位 {(overviewKpi?.median_session_ms ?? 0) > 0
                ? `${((overviewKpi?.median_session_ms ?? 0) / 60_000).toFixed(1)} 分钟`
                : '-'}
            </Text>
            <KpiDeltaText delta={deltaText(overviewKpi?.minutes_per_user, previousKpi?.minutes_per_user, { digits: 1 })} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card className="kpi-card" style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="窗口结束时刻往前 1 小时内、任意事件的去重用户。选「今天」时约等于当前近 1 小时在线。">
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
          <Card className="kpi-card" style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="全库首次 session_start 落在当前窗口内的去重用户数（窗口内新增）。">
              <Statistic title="窗口内新增" value={overviewKpi?.new_users_today ?? 0} suffix="人" />
            </Tooltip>
            <KpiDeltaText delta={deltaText(overviewKpi?.new_users_today, previousKpi?.new_users_today, { digits: 1 })} />
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card className="kpi-card" style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="新增次留：锚点日前 1 日首次进入的新用户中，锚点日再次 session_start 的比例。≠ 活跃次留。">
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
          <Card className="kpi-card" style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="锚点日前 7 日新增 cohort 中，锚点日仍有 session_start 的比例。打点不足 7 天时为 0。">
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
          <Card className="kpi-card" style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="本页 overview 指标最近一次服务端计算完成时间；下方为查询窗口起始日。数据约每 5 分钟增量聚合。">
              <Statistic
                title="计算时刻"
                value={
                  overviewKpi?.computed_at
                    ? new Date(overviewKpi.computed_at).toLocaleTimeString('zh-CN')
                    : '-'
                }
              />
            </Tooltip>
            <Text type="secondary">{overview?.query?.from?.slice(0, 10) || '-'}</Text>
          </Card>
        </Col>
        <Col span={24}>
          <Card
            title={
              <Tooltip title="同比昨日同一时间段。投放消耗优先腾讯广告实时接口，失败时回退已补录经营数据。">
                <span>投放与商业化波动（同时间段 vs 昨日）</span>
              </Tooltip>
            }
          >
            <Row gutter={[16, 16]}>
              <Col xs={12} md={6} xl={3}>
                <Tooltip title="窗口内投放消耗（元）。优先腾讯广告实时；接口失败见下方对比文案。">
                  <Statistic title="投放消耗" value={currentSpend ?? '-'} suffix={currentSpend === undefined ? undefined : '元'} precision={2} />
                </Tooltip>
                <KpiDeltaText delta={deltaText(currentSpend, previousSpend, { digits: 1, unavailableText: acquisitionSource })} />
              </Col>
              <Col xs={12} md={6} xl={3}>
                <Tooltip title="投放消耗 ÷ 窗口内新增用户。越低获客越便宜（对比箭头反向解读）。">
                  <Statistic title="投放 CPI" value={currentCpi ?? '-'} suffix={currentCpi === null ? undefined : '元'} precision={4} />
                </Tooltip>
                <KpiDeltaText delta={deltaText(currentCpi, previousCpi, { digits: 1, reverseGood: true, unavailableText: acquisitionSource })} />
              </Col>
              <Col xs={12} md={6} xl={3}>
                <Tooltip title="日活里看过广告的人数 ÷ 日活。日活是 session_start 去重，和本页日活同一批人。">
                  <Statistic title="广告渗透" value={currentAd?.ad_penetration_rate ?? 0} suffix="%" precision={1} />
                </Tooltip>
                <KpiDeltaText delta={deltaText(currentAd?.ad_penetration_rate, previousAd?.ad_penetration_rate, { digits: 1 })} />
              </Col>
              <Col xs={12} md={6} xl={3}>
                <Tooltip title="窗口内广告展示次数 ÷ 活跃用户。">
                  <Statistic title="人均广告展示" value={currentAd?.ad_show_per_uu ?? 0} suffix="次" precision={2} />
                </Tooltip>
                <KpiDeltaText delta={deltaText(currentAd?.ad_show_per_uu, previousAd?.ad_show_per_uu, { digits: 1 })} />
              </Col>
              <Col xs={12} md={6} xl={3}>
                <Tooltip title="广告填充成功次数 ÷ 请求次数。">
                  <Statistic title="填充率" value={currentAd?.fill_rate ?? 0} suffix="%" precision={1} />
                </Tooltip>
                <KpiDeltaText delta={deltaText(currentAd?.fill_rate, previousAd?.fill_rate, { digits: 1 })} />
              </Col>
              <Col xs={12} md={6} xl={3}>
                <Tooltip title="完播次数 ÷ 曝光次数。激励视频看完的比例，和下面广告变现里的完播率同一口径。">
                  <Statistic title="完播率" value={currentAd?.completion_rate ?? 0} suffix="%" precision={1} />
                </Tooltip>
                <KpiDeltaText delta={deltaText(currentAd?.completion_rate, previousAd?.completion_rate, { digits: 1 })} />
              </Col>
              <Col xs={12} md={6} xl={3}>
                <Tooltip title="窗口内广告预估收益（元）。优先流量主真实 eCPM，缺失时用配置 eCPM。">
                  <Statistic title="广告收益" value={currentAd?.total_revenue_estimated_cny ?? 0} suffix="元" precision={2} />
                </Tooltip>
                <KpiDeltaText
                  delta={deltaText(currentAd?.total_revenue_estimated_cny, previousAd?.total_revenue_estimated_cny, {
                    digits: 1,
                  })}
                />
              </Col>
            </Row>
          </Card>
        </Col>
        <Col span={24}>
          <Card
            title={
              <Tooltip
                title={
                  onlineCurve?.bucket_minutes === 60
                    ? '窗口超过 2 天，改成每小时一个点：这一小时里出现过任意事件的人数。比 5 分钟在线更宽，数字会更高。'
                    : '每个点是这一小段 5 分钟里出现过任意事件的人数。超过 5 分钟没有操作算出线，和总览「当前在线」同一口径。虚线是昨日同一时刻。'
                }
              >
                <span>实时在线</span>
              </Tooltip>
            }
            extra={
              onlineCurve?.ok ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {onlineCurve.live ? '当前' : onlineCurve.bucket_minutes === 60 ? '最后一小时' : '结束时'}{' '}
                  <Text strong>{onlineCurve.current ?? 0}</Text> 人
                  {' · '}
                  峰值 <Text strong>{onlineCurve.peak ?? 0}</Text> 人
                  {onlineCurve.peak_label ? `（${onlineCurve.peak_label}）` : ''}
                </Text>
              ) : null
            }
          >
            {onlineCurve?.ok === false ? (
              <Empty description={`在线曲线没有读到：${onlineCurve.error || onlineCurve.code || '接口失败'}`} />
            ) : (onlineCurve?.points?.length || 0) > 0 ? (
              <ReactECharts option={onlineChartOption} style={{ height: 280 }} notMerge lazyUpdate />
            ) : (
              <Empty description="这段时间没有在线记录" />
            )}
          </Card>
        </Col>
        <Col span={24}>
          <Card
            title={
              <Tooltip title="按 5 分钟桶聚合的活跃 / 新增趋势。这里是每个桶里有 session_start 的人，不是此刻还在线的人。">
                <span>活跃 / 新增趋势</span>
              </Tooltip>
            }
          >
            {(overview?.series?.length || 0) > 0 ? (
              <ReactECharts option={activeChartOption} style={{ height: 320 }} />
            ) : (
              <Empty description="暂无打点数据，请确认游戏端已上报 session_start 事件" />
            )}
          </Card>
        </Col>
        <Col span={24}>
          <Card
            title="在线时长分布"
            extra={(
              <Text type="secondary" style={{ fontSize: 12 }}>
                只统计拼出有效会话的人。横轴是分钟，纵轴是人数
                {overviewKpi?.minutes_per_user != null ? `；人均 ${overviewKpi.minutes_per_user.toFixed(1)} 分钟` : ''}
              </Text>
            )}
          >
            {durationHistogram.some((bin) => bin.users > 0) ? (
              <ReactECharts option={durationHistogramOption} style={{ height: 320 }} notMerge lazyUpdate />
            ) : (
              <Empty description="这段时间拼不出有效会话" />
            )}
          </Card>
        </Col>
      </Row>

      <PaybackSection gameKey={gameKey} platform={platform} refreshToken={refreshToken} />
      <RealtimeAdRevenue fixedGameKey={gameKey} platform={platform} windowSel={windowSel} refreshToken={refreshToken} />
      <RealtimeShare fixedGameKey={gameKey} platform={platform} windowSel={windowSel} refreshToken={refreshToken} />
    </Space>
  );
}

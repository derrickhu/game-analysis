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
import { useNavigate } from 'react-router-dom';

import { getGameDescriptor } from '../../shared/games';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { RealtimeAdRevenue } from '../RealtimeAdRevenue';
import { RealtimeShare } from '../RealtimeShare';
import { buildWindowQuery, type WindowValue } from '../timeWindow';

const { Text } = Typography;

interface OverviewKpi {
  dau: number;
  active_users_1h: number;
  new_users_today: number;
  retention_d1_rate: number | null;
  /** 分母：D-1 cohort（锚点前 1 日去重数） */
  retention_d1_cohort: number;
  /** 分子：cohort 中锚点日仍有事件的去重数 */
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
  summary?: { total_revenue_estimated_cny?: number };
  code?: string;
  error?: string;
}

interface RetentionSummaryResponse {
  ok: boolean;
  cohort_date?: string;
  overall?: {
    cohort_size: number;
    points: Array<{ age_day: number; retained_users: number | null; retention_rate: number | null; is_complete_day: boolean }>;
  };
  devices?: Array<{
    device_type: string;
    cohort_size: number;
    points: Array<{ age_day: number; retained_users: number | null; retention_rate: number | null; is_complete_day: boolean }>;
  }>;
  code?: string;
  error?: string;
}

function formatRetentionRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return (value * 100).toFixed(1);
}

function retentionPoint(
  segment: { points: Array<{ age_day: number; retention_rate: number | null }> } | undefined,
  ageDay: number,
): number | null {
  return segment?.points.find((point) => point.age_day === ageDay)?.retention_rate ?? null;
}

function buildDeviceRetentionInsight(data: RetentionSummaryResponse | null): string {
  const candidates = (data?.devices || [])
    .map((device) => ({
      deviceType: device.device_type,
      cohortSize: device.cohort_size,
      d7: retentionPoint(device, 7),
    }))
    .filter((item) => item.cohortSize >= 30 && item.d7 !== null)
    .sort((a, b) => Number(b.d7) - Number(a.d7));
  if (candidates.length === 0) return '设备样本不足，暂不判断平台差异';
  const best = candidates[0];
  const worst = candidates[candidates.length - 1];
  if (!worst || best.deviceType === worst.deviceType) {
    return `${best.deviceType} D7 留存 ${(Number(best.d7) * 100).toFixed(1)}%，当前样本最稳`;
  }
  return `${best.deviceType} D7 ${(Number(best.d7) * 100).toFixed(1)}%，高于 ${worst.deviceType} ${(Number(worst.d7) * 100).toFixed(1)}%`;
}

function formatRetentionFraction(
  cohortDate: string | undefined,
  anchorDate: string | undefined,
  returned: number | undefined,
  cohort: number | undefined,
): string {
  const cohortLabel = cohortDate ? `${cohortDate} 活跃` : 'cohort';
  const anchorLabel = anchorDate ? `${anchorDate} 回访` : '锚点日回访';
  if (cohort === undefined || cohort === 0) return `${cohortLabel} 0 人，暂无样本`;
  return `${cohortLabel} ${cohort} 人 → ${anchorLabel} ${returned ?? 0} 人`;
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

/**
 * 大盘运营页面 = 通用 KPI + 活跃/新增趋势 + 广告变现 + 分享传播。
 *
 * 这里只展示对所有游戏一致的"经营大盘"指标，游戏专属玩法（关卡漏斗/任务漏斗等）
 * 在 /business/gameplay 单独承载。这样所有游戏的大盘视图视觉对齐、产品决策口径一致。
 */
export function DashboardPage() {
  const navigate = useNavigate();
  const {
    gameKey,
    windowSel,
    refreshToken,
    setLoading,
    setLastRefreshedAt,
  } = useAnalyticsFilter();

  const gameDescriptor = getGameDescriptor(gameKey);
  const isIntegrated = gameDescriptor?.hasAnalyticsSdk === true;

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [adSummary, setAdSummary] = useState<AdSummaryLiteResponse | null>(null);
  const [retentionSummary, setRetentionSummary] = useState<RetentionSummaryResponse | null>(null);
  const requestSeqRef = useRef(0);

  const loadAll = useCallback(
    async (nextGameKey: string, nextWindow: WindowValue) => {
      const desc = getGameDescriptor(nextGameKey);
      if (!desc?.hasAnalyticsSdk) {
        setOverview(null);
        setAdSummary(null);
        setLastRefreshedAt(Date.now());
        return;
      }
      const seq = ++requestSeqRef.current;
      setLoading(true);
      try {
        const queryStr = buildWindowQuery(nextWindow);
        const overviewPromise = fetch(
          `/api/realtime/overview?game=${encodeURIComponent(nextGameKey)}&${queryStr}`,
        ).then((r) => r.json() as Promise<OverviewResponse>);
        const adSummaryPromise = fetch(
          `/api/realtime/ad-revenue?game=${encodeURIComponent(nextGameKey)}&${queryStr}`,
        ).then((r) => r.json() as Promise<AdSummaryLiteResponse>);
        const retentionSummaryPromise = fetch(
          `/api/realtime/retention-cohort?game=${encodeURIComponent(nextGameKey)}&max_age=7`,
        ).then((r) => r.json() as Promise<RetentionSummaryResponse>);
        const [ovRes, adRes, retentionRes] = await Promise.all([overviewPromise, adSummaryPromise, retentionSummaryPromise]);
        // 防止竞态：仅最新一次请求结果生效
        if (seq !== requestSeqRef.current) return;
        if (!ovRes.ok) {
          message.error(`获取 overview 失败: ${ovRes.error || ovRes.code}`);
        }
        setOverview(ovRes);
        setAdSummary(adRes);
        setRetentionSummary(retentionRes.ok ? retentionRes : null);
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        message.error(`加载大盘失败: ${String(error)}`);
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [setLoading, setLastRefreshedAt],
  );

  useEffect(() => {
    void loadAll(gameKey, windowSel);
  }, [gameKey, windowSel, refreshToken, loadAll]);

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
  const summaryD1 = retentionPoint(retentionSummary?.overall, 1);
  const summaryD7 = retentionPoint(retentionSummary?.overall, 7);
  const retentionInsight = buildDeviceRetentionInsight(retentionSummary);

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
              用户身份：优先 user_id（业务 openid），未登录时降级到 anonymous_id；活跃用 session_start
              去重；留存以"窗口结束日所在自然日"为锚点，cohort=锚点日前 1/7 日整日，retain=cohort
              中锚点日仍有事件的去重数。
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
            <Text type="secondary">session_start 去重</Text>
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
            <Text type="secondary">所有事件去重</Text>
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="在全表中首次出现于当前时间窗口内的去重用户数。">
              <Statistic title="窗口内新增" value={overviewKpi?.new_users_today ?? 0} suffix="人" />
            </Tooltip>
            <Text type="secondary">全表首次出现</Text>
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="窗口内广告曝光数 × 配置 eCPM 的估算收益（元），仅供参考；以微信流量主结算为准。">
              <Statistic
                title="预估收益"
                value={(adSummary?.summary?.total_revenue_estimated_cny ?? 0).toFixed(2)}
                suffix="元"
              />
            </Tooltip>
            <Text type="secondary">估算值，非真实结算</Text>
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="锚点日 = 当前时间窗口结束日所在自然日。次留 D1 = 锚点日前 1 日 cohort 中、在锚点日仍有事件的比例。窗口切到 5/8 一整天时即为 5/7 → 5/8 的次留。">
              <Statistic
                title="次留 D1"
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
          </Card>
        </Col>
        <Col xs={12} md={6} xl={3} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="7 留 D7 = 锚点日前 7 日 cohort 中、在锚点日仍有事件的比例。打点不足 7 天时 cohort 为 0。">
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
            title="留存摘要（cohort 非实时）"
            extra={
              <Button
                type="link"
                onClick={() => navigate({ pathname: '/business/retention', search: `?game=${encodeURIComponent(gameKey)}` })}
              >
                查看留存分析
              </Button>
            }
          >
            <Row gutter={[16, 16]} align="middle">
              <Col xs={12} md={4}>
                <Statistic title="Cohort 日期" value={retentionSummary?.cohort_date || '-'} />
              </Col>
              <Col xs={12} md={4}>
                <Statistic title="Cohort 人数" value={retentionSummary?.overall?.cohort_size ?? 0} suffix="人" />
              </Col>
              <Col xs={12} md={4}>
                <Statistic title="D1 次留" value={summaryD1 !== null ? summaryD1 * 100 : 0} suffix="%" precision={1} />
              </Col>
              <Col xs={12} md={4}>
                <Statistic title="D7 留存" value={summaryD7 !== null ? summaryD7 * 100 : 0} suffix="%" precision={1} />
              </Col>
              <Col xs={24} md={8}>
                <Space orientation="vertical" size={0}>
                  <Text>{retentionInsight}</Text>
                  <Text type="secondary">
                    取最近 D7 已成熟的 cohort；完整 D0-D30 曲线和设备筛选请进入留存分析页。
                  </Text>
                </Space>
              </Col>
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

      <RealtimeAdRevenue fixedGameKey={gameKey} windowSel={windowSel} refreshToken={refreshToken} />
      <RealtimeShare fixedGameKey={gameKey} windowSel={windowSel} refreshToken={refreshToken} />
    </Space>
  );
}

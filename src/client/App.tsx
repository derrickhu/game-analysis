import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Layout, Result, Row, Select, Space, Statistic, Tabs, Tag, Tooltip, Typography, message } from 'antd';
import ReactECharts from 'echarts-for-react';

import { ALL_GAMES, getDefaultGameKey, getGameDescriptor } from '../shared/games';
import { EventsExplorer } from './EventsExplorer';
import { RealtimeAdRevenue } from './RealtimeAdRevenue';
import { DEFAULT_WINDOW, WINDOW_OPTIONS, type WindowValue, buildWindowQuery } from './timeWindow';

const { Header, Content } = Layout;
const { Title, Text } = Typography;

/**
 * 游戏经营分析 dashboard
 *
 * 架构（已切到 SDK 打点流水驱动）：
 * - 大盘 KPI / 活跃趋势 / 新增曲线 → /api/realtime/overview （from analytics_events）
 * - 广告事件流（5min 粒度）       → /api/realtime/ad-revenue
 * - hot-pot 关卡进度（游戏独有）   → /api/realtime/hotpot-progress （hotpot only）
 *
 * 已下线（不再调用）：
 * - /api/dashboard、/api/metrics/recompute、/api/ingest/cloudbase
 *   这些是老的「存档快照差分」链路，hot-pot 接入 SDK 后不再使用。
 *   接入方按 README.md 复用 SDK，DB 拉取链路彻底退役。
 */

/**
 * 自动刷新周期。
 *
 * 后端 cron 是 `*\/5 * * * *`（每 5 分钟整点拉一次 events 入库 + 重算 ad bucket），
 * 前端拉得比 5 分钟更勤是浪费（拿到的是同一份数据）；拉得比 5 分钟更少又会漏掉新桶。
 * 所以前端也按 5 分钟节奏自动刷新，跟后端对齐。
 *
 * 用户主动点「刷新」/「立即拉取」时不受此节奏限制，立即触发 refreshToken++。
 */
const AUTO_REFRESH_MS = 5 * 60_000;

interface OverviewKpi {
  dau: number;
  active_users_1h: number;
  new_users_today: number;
  retention_d1_rate: number | null;
  /** 分母：D-1 cohort（昨日 DAU 去重数） */
  retention_d1_cohort: number;
  /** 分子：cohort 中今日仍有事件的去重数 */
  retention_d1_returned: number;
  retention_d7_rate: number | null;
  retention_d7_cohort: number;
  retention_d7_returned: number;
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

interface ProgressKpi {
  total_starts: number;
  total_clears: number;
  total_fails: number;
  max_cleared_level: number;
  avg_clear_duration_ms: number;
  clear_rate: number | null;
  computed_at: number;
}

interface LevelDistributionRow {
  level_id: number;
  start_users: number;
  clear_users: number;
  fail_users: number;
  pass_rate: number | null;
}

interface ProgressSeriesPoint {
  bucket: string;
  ts: number;
  start_cnt: number;
  clear_cnt: number;
  fail_cnt: number;
}

interface ProgressResponse {
  ok: boolean;
  query?: { game_key: string; from: string; to: string; window_minutes: number };
  kpi?: ProgressKpi;
  distribution?: LevelDistributionRow[];
  series?: ProgressSeriesPoint[];
  code?: string;
  error?: string;
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('zh-CN');
}

function formatRetentionRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return (value * 100).toFixed(1);
}

/**
 * 把次留 / 7 留的「分子 / 分母」格式化成中文副标题。
 * 故意用「活跃 → 今日回访」的箭头形式，让分母（cohort）和分子（回访）一眼就能看懂。
 * cohort 为 0 时给一句明确话术，避免显示 0/0 让人误解。
 *
 * @param baseLabel 分母语义，例如「昨日活跃」「7 天前活跃」
 * @param returned 分子：cohort 中今日仍有事件的去重数
 * @param cohort 分母：cohort 去重数
 */
function formatRetentionFraction(
  baseLabel: string,
  returned: number | undefined,
  cohort: number | undefined,
): string {
  if (cohort === undefined || cohort === 0) return `${baseLabel} 0 人，暂无样本`;
  return `${baseLabel} ${cohort} 人 → 今日回访 ${returned ?? 0} 人`;
}

/** 6 张 KPI 卡片共用的容器样式：同高 + 统一 padding，避免「次留多一行副标题」造成的高度抖动 */
const kpiCardStyle = { width: '100%', height: '100%' } as const;
const kpiCardStyles = { body: { minHeight: 110, display: 'flex', flexDirection: 'column' as const, justifyContent: 'space-between' as const } };

function formatDuration(ms: number): string {
  if (!ms) return '-';
  const sec = Math.round(ms / 1000);
  const min = Math.floor(sec / 60);
  const remain = sec % 60;
  return `${min}m ${remain}s`;
}

/**
 * 5 分钟桶字符串转本地时区标签，给 X 轴用。
 * 后端 tsToBucket 给的是 UTC 字符串（"YYYY-MM-DDTHH:mm" + 隐含 Z），
 * 直接 slice(11) 显示出来是 UTC 时间，会让北京用户看到偏移 8 小时的奇怪刻度。
 * 这里转成本地时区的 MM-DD HH:mm，与 RealtimeAdRevenue 内部 formatMinuteLabel 同款。
 */
function bucketShort(bucket: string): string {
  if (!bucket) return '';
  const utcDate = new Date(`${bucket}:00.000Z`);
  if (isNaN(utcDate.getTime())) return bucket;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(utcDate.getMonth() + 1)}-${pad(utcDate.getDate())} ${pad(utcDate.getHours())}:${pad(utcDate.getMinutes())}`;
}

export function App() {
  const [gameKey, setGameKey] = useState(getDefaultGameKey());
  // windowSel / refreshToken 都是【全局状态】，由顶部 Header 上的 Select / 刷新 / 立即拉取统一驱动；
  // 所有面板（overview KPI、广告、关卡进度）都跟随刷新，不再各自维护时间窗口
  const [windowSel, setWindowSel] = useState<WindowValue>(DEFAULT_WINDOW);
  const [refreshToken, setRefreshToken] = useState(0);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [ingestingNow, setIngestingNow] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(0);
  const requestSeqRef = useRef(0);

  const gameDescriptor = getGameDescriptor(gameKey);
  const isIntegrated = gameDescriptor?.hasAnalyticsSdk === true;
  const isHotpot = gameKey === 'hotpot';

  const loadAll = useCallback(async (nextGameKey: string, nextWindow: WindowValue) => {
    const desc = getGameDescriptor(nextGameKey);
    if (!desc?.hasAnalyticsSdk) {
      // 未接入 SDK，dashboard 完全无数据可拉，直接置空
      setOverview(null);
      setProgress(null);
      setLastRefreshedAt(Date.now());
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const queryStr = buildWindowQuery(nextWindow);
      const overviewPromise = fetch(`/api/realtime/overview?game=${encodeURIComponent(nextGameKey)}&${queryStr}`).then((r) => r.json() as Promise<OverviewResponse>);
      const progressPromise = nextGameKey === 'hotpot'
        ? fetch(`/api/realtime/hotpot-progress?game=${encodeURIComponent(nextGameKey)}&${queryStr}`).then((r) => r.json() as Promise<ProgressResponse>)
        : Promise.resolve<ProgressResponse | null>(null);
      const [ovRes, pgRes] = await Promise.all([overviewPromise, progressPromise]);
      // 防止竞态：仅最新一次请求结果生效
      if (seq !== requestSeqRef.current) return;
      if (!ovRes.ok) {
        message.error(`获取 overview 失败: ${ovRes.error || ovRes.code}`);
      }
      setOverview(ovRes);
      setProgress(pgRes);
      setLastRefreshedAt(Date.now());
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      message.error(`加载看板失败: ${String(error)}`);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, []);

  // 任何 game / window / refreshToken 变化都会触发统一的全局刷新；自动定时器也是改 refreshToken
  useEffect(() => {
    void loadAll(gameKey, windowSel);
  }, [gameKey, windowSel, refreshToken, loadAll]);

  // 自动 5 分钟刷新：与后端 cron */5 对齐，避免出现"前端先拉、cron 还没跑、看到老桶"的尴尬窗口
  // 首次进入时不再立即多触发一次刷新（loadAll 已经在 mount 时跑过了），等满 5 分钟才滚动
  useEffect(() => {
    const timer = window.setInterval(() => {
      setRefreshToken((t) => t + 1);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * 顶部「立即拉取并刷新」按钮：
   * 1) 后端走一次 CloudBase 增量拉取（绕过 5 分钟 cron）
   * 2) 拉取成功后立即 setRefreshToken+1，触发所有子面板重新 fetch
   * 3) 按钮 loading 多保留 ~800ms，给子组件 fetch 留一个视觉窗口，
   *    避免「按钮 loading 一闪就停 / 但下方面板还在静默加载」的割裂感
   */
  const triggerIngestNow = useCallback(async () => {
    setIngestingNow(true);
    try {
      const res = await fetch('/api/realtime/ingest-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: gameKey }),
      });
      const json = await res.json();
      if (json.ok) {
        setRefreshToken((t) => t + 1);
        message.success(
          `已拉取 ${json.fetched ?? 0} 条新事件（入库 ${json.inserted ?? 0}），所有面板已自动刷新`,
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
      } else {
        message.error(`立即拉取失败：${json.error || '未知错误'}`);
      }
    } catch (err) {
      message.error(`立即拉取异常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIngestingNow(false);
    }
  }, [gameKey]);

  // 活跃 / 新增双线（5 分钟桶）
  const activeChartOption = useMemo(() => {
    const series = overview?.series || [];
    const xAxis = series.map((p) => bucketShort(p.bucket));
    // 5 分钟桶 1 小时 = 12 桶；今日窗口最多 ~288 桶。
    // 默认 zoom 到最近 60 桶（约 5 小时），避免标签过密；用户拖 slider 查看全天
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

  // 关卡分布柱图（hotpot 独有）
  const levelDistOption = useMemo(() => {
    const dist = progress?.distribution || [];
    const xAxis = dist.map((d) => `第${d.level_id}关`);
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any[]) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const lv = params[0].axisValue;
          const row = dist[params[0].dataIndex];
          if (!row) return lv;
          const passText = row.pass_rate === null ? '-' : `${(row.pass_rate * 100).toFixed(1)}%`;
          return `${lv}<br/>尝试用户: ${row.start_users}<br/>通关用户: ${row.clear_users}<br/>放弃用户: ${row.fail_users}<br/>通关率: ${passText}`;
        },
      },
      legend: {
        data: ['尝试', '通关', '放弃'],
        textStyle: { color: '#374151', fontSize: 13, fontWeight: 500 },
      },
      grid: { left: 50, right: 30, top: 50, bottom: 60 },
      xAxis: { type: 'category', data: xAxis },
      yAxis: { type: 'value', name: '人数', minInterval: 1 },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 10 }],
      series: [
        {
          name: '尝试',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#94a3b8', borderRadius: [4, 4, 0, 0] },
          data: dist.map((d) => d.start_users),
        },
        {
          name: '通关',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] },
          data: dist.map((d) => d.clear_users),
        },
        {
          name: '放弃',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#ef4444', borderRadius: [4, 4, 0, 0] },
          data: dist.map((d) => d.fail_users),
        },
      ],
    };
  }, [progress?.distribution]);

  // 通关 / 失败时间趋势（5 分钟桶）
  const levelTrendOption = useMemo(() => {
    const series = progress?.series || [];
    const xAxis = series.map((p) => bucketShort(p.bucket));
    const zoomStart = series.length > 60 ? Math.max(0, 100 - (60 / series.length) * 100) : 0;
    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['开始', '通关', '失败'],
        textStyle: { color: '#374151', fontSize: 13, fontWeight: 500 },
      },
      grid: { left: 50, right: 30, top: 50, bottom: 60 },
      xAxis: { type: 'category', data: xAxis, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', name: '次数', minInterval: 1 },
      dataZoom: [
        { type: 'inside', start: zoomStart, end: 100 },
        { type: 'slider', height: 18, bottom: 10, start: zoomStart, end: 100 },
      ],
      series: [
        {
          name: '开始',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#94a3b8' },
          data: series.map((p) => p.start_cnt),
        },
        {
          name: '通关',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#10b981' },
          data: series.map((p) => p.clear_cnt),
        },
        {
          name: '失败',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#ef4444' },
          data: series.map((p) => p.fail_cnt),
        },
      ],
    };
  }, [progress?.series]);

  const overviewKpi = overview?.kpi;
  const progressKpi = progress?.kpi;

  const overviewSection = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="实时趋势 · 5 分钟粒度"
        description={(
          <Space direction="vertical" size={0}>
            <Text>数据来源：@gp/analytics-sdk 打点流水（analytics_events），cron 每 5 分钟增量拉取并聚合。</Text>
            <Text type="secondary">用户身份：优先 user_id（业务 openid），未登录时降级到 anonymous_id；活跃用 session_start 去重，留存为前一日 / 七日前 cohort 在今日有事件比例。</Text>
          </Space>
        )}
      />

      {/*
        KPI 卡片整排：
        - 所有 Card 用同一套 styles（统一 body minHeight）保持视觉高度对齐
        - Col 加 display:flex，让 Card 的 height:100% 在等高 Row 中真正撑满
        - 留存卡片在副标题位置展示「分子/分母」，便于人工核对 cohort 是否过小
      */}
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={12} md={8} xl={4} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Statistic title="今日 DAU" value={overviewKpi?.dau ?? 0} suffix="人" />
            <Text type="secondary">基于 session_start 去重</Text>
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Statistic title="近 1 小时活跃" value={overviewKpi?.active_users_1h ?? 0} suffix="人" />
            <Text type="secondary">所有事件去重</Text>
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Statistic title="今日新增" value={overviewKpi?.new_users_today ?? 0} suffix="人" />
            <Text type="secondary">全表首次出现</Text>
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="昨日 DAU 中今日仍有事件的比例。冷启动期 cohort 较小时波动会大，请结合绝对值判断。">
              <Statistic
                title="次留 D1"
                value={formatRetentionRate(overviewKpi?.retention_d1_rate)}
                suffix={overviewKpi?.retention_d1_rate ? '%' : ''}
              />
            </Tooltip>
            <Text type="secondary">
              {formatRetentionFraction(
                '昨日活跃',
                overviewKpi?.retention_d1_returned,
                overviewKpi?.retention_d1_cohort,
              )}
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Tooltip title="7 天前 DAU 中今日仍有事件的比例。打点不足 7 天时显示为 -。">
              <Statistic
                title="7 留 D7"
                value={formatRetentionRate(overviewKpi?.retention_d7_rate)}
                suffix={overviewKpi?.retention_d7_rate ? '%' : ''}
              />
            </Tooltip>
            <Text type="secondary">
              {formatRetentionFraction(
                '7 天前活跃',
                overviewKpi?.retention_d7_returned,
                overviewKpi?.retention_d7_cohort,
              )}
            </Text>
          </Card>
        </Col>
        <Col xs={12} md={8} xl={4} style={{ display: 'flex' }}>
          <Card style={kpiCardStyle} styles={kpiCardStyles}>
            <Statistic
              title="计算时刻"
              value={overviewKpi?.computed_at ? new Date(overviewKpi.computed_at).toLocaleTimeString('zh-CN') : '-'}
            />
            <Text type="secondary">{overview?.query?.from?.slice(0, 10) || '-'}</Text>
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
    </Space>
  );

  const hotpotProgressSection = isHotpot && (
    <Card
      title={(
        <Space>
          <span>关卡进度（hotpot 独有）</span>
          <Tag color="purple">游戏独立</Tag>
        </Space>
      )}
      extra={<Text type="secondary">数据源：level_start / level_clear / level_fail</Text>}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="总尝试" value={progressKpi?.total_starts ?? 0} suffix="次" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="总通关" value={progressKpi?.total_clears ?? 0} suffix="次" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="= 通关次数 / 开始次数。失败重试也算独立尝试。">
                <Statistic
                  title="通关率"
                  value={progressKpi?.clear_rate !== null && progressKpi?.clear_rate !== undefined
                    ? (progressKpi.clear_rate * 100).toFixed(1)
                    : '-'}
                  suffix={progressKpi?.clear_rate ? '%' : ''}
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="全服最高已通关" value={progressKpi?.max_cleared_level ?? 0} suffix="关" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="平均通关耗时" value={formatDuration(progressKpi?.avg_clear_duration_ms ?? 0)} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="放弃次数" value={progressKpi?.total_fails ?? 0} suffix="次" />
            </Card>
          </Col>
        </Row>

        <Card type="inner" title="各关卡用户分布">
          {(progress?.distribution?.length || 0) > 0 ? (
            <ReactECharts option={levelDistOption} style={{ height: 320 }} />
          ) : (
            <Empty description="暂无关卡数据，请玩 hotpot 触发 level_start" />
          )}
        </Card>

        <Card type="inner" title="关卡事件趋势（5 分钟桶 · 当日）">
          {(progress?.series?.length || 0) > 0 ? (
            <ReactECharts option={levelTrendOption} style={{ height: 280 }} />
          ) : (
            <Empty description="今日还没有 level_* 事件" />
          )}
        </Card>
      </Space>
    </Card>
  );

  // 实时趋势页：通用 overview + 广告 + （hot-pot）关卡独立模块
  // 三个面板都共用顶部全局的 windowSel / refreshToken，不再各自维护刷新逻辑
  const trendDashboard = (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {overviewSection}
      <RealtimeAdRevenue fixedGameKey={gameKey} windowSel={windowSel} refreshToken={refreshToken} />
      {hotpotProgressSection}
    </Space>
  );

  // 未接入打点 SDK 的游戏：dashboard 完全无数据，给接入引导
  const notIntegratedNotice = (
    <Result
      status="info"
      title={`${gameDescriptor?.displayName ?? gameKey} 暂未接入打点 SDK`}
      subTitle="该游戏还没有标准化的打点流水，dashboard 暂时无数据可展示。请先在游戏端接入 @gp/analytics-sdk。"
      extra={(
        <Space direction="vertical" size="small" align="start">
          <Text>接入步骤详见 <Text code>game-analysis/packages/analytics-sdk/README.md</Text>，约 30 分钟可完成。</Text>
          <Text type="secondary">关键步骤：① 项目内 import @gp/analytics-sdk → ② 注入 Platform Adapter（参考 hot-pot 写法） → ③ 启动尽早调用 <Text code>initAnalytics()</Text> → ④ 业务打点用 <Text code>analytics.track(...)</Text>。</Text>
          <Text type="secondary">接入完成后，把 <Text code>shared/games.ts</Text> 中本游戏的 <Text code>hasAnalyticsSdk</Text> 翻 true，并把 <Text code>server/config/analytics-games.ts</Text> 中的 <Text code>enabled</Text> 也翻 true，cron 会自动开始拉取。</Text>
        </Space>
      )}
    />
  );

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div>
          <Title level={3} className="app-title">游戏经营分析</Title>
          <Text type="secondary">已接入 @gp/analytics-sdk 的游戏从打点流水拉数据，未接入的请先按指引接入</Text>
        </div>
        {/*
          顶部统一控制台：游戏切换 + 时间窗口 + 全局刷新 + 立即拉取
          所有面板共用这套筛选器，避免各 Card 内再单独维护
        */}
        <Space wrap>
          <Select
            value={gameKey}
            onChange={(value) => setGameKey(value)}
            className="game-input"
            style={{ minWidth: 200 }}
            options={ALL_GAMES.map((item) => ({
              value: item.gameKey,
              label: (
                <Space>
                  <span>{item.displayName}</span>
                  {!item.hasAnalyticsSdk && <Tag color="default" style={{ marginInlineEnd: 0 }}>未接入</Tag>}
                </Space>
              ),
            }))}
          />
          <Select
            value={windowSel}
            onChange={(v) => setWindowSel(v)}
            options={WINDOW_OPTIONS}
            style={{ width: 160 }}
            disabled={!isIntegrated}
          />
          <Button
            onClick={() => setRefreshToken((t) => t + 1)}
            loading={loading}
            disabled={!isIntegrated}
          >
            刷新
          </Button>
          <Tooltip title="手动从 CloudBase 增量拉取一次事件到本地（绕过 5 分钟 cron），完成后自动刷新所有面板">
            <Button
              type="primary"
              onClick={() => void triggerIngestNow()}
              loading={ingestingNow}
              disabled={!isIntegrated}
            >
              立即拉取并刷新
            </Button>
          </Tooltip>
          <Text type="secondary">自动 5 分钟 · {formatTime(lastRefreshedAt)}</Text>
        </Space>
      </Header>

      <Content className="app-content">
        {isIntegrated ? (
          <Tabs
            items={[
              { key: 'trend', label: `${gameDescriptor?.displayName ?? gameKey} 实时趋势`, children: trendDashboard },
              {
                key: 'events',
                label: '原始事件',
                children: (
                  <EventsExplorer
                    fixedGameKey={gameKey}
                    windowSel={windowSel}
                    refreshToken={refreshToken}
                  />
                ),
              },
            ]}
          />
        ) : (
          notIntegratedNotice
        )}
      </Content>
    </Layout>
  );
}

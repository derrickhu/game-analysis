import { Alert, Button, Segmented, Space, Spin, Typography } from 'antd';
import type { EChartsOption } from 'echarts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { PlatformFilter } from '../../shared/platforms';
import ReactECharts from '../components/AnalyticsChart';
import { GameIcon } from '../components/GameIcon';
import { fetchJson } from '../fetchJson';

type RevenueGranularity = 'day' | 'month';
type RevenueChannel = 'total' | 'wechat' | 'douyin';

const { Text, Title } = Typography;

interface HomePlatformDau {
  platform: PlatformFilter;
  label: string;
  dau: number;
  ad_show_cnt: number;
  t1_revenue_cny: number;
}

interface HomeGameDau {
  game_key: string;
  display_name: string;
  total_dau: number;
  total_ad_show: number;
  month_t1_revenue_cny: number;
  platforms: HomePlatformDau[];
}

interface HomeMonthlyGameSeries {
  game_key: string;
  display_name: string;
  revenue: number[];
}

interface HomeChannelTrend {
  games: HomeMonthlyGameSeries[];
  total: number[];
}

interface HomeMonthlyTrend {
  months: string[];
  games: HomeMonthlyGameSeries[];
  total: number[];
  wechat: HomeChannelTrend;
  douyin: HomeChannelTrend;
}

interface HomeDailyTrend {
  days: string[];
  games: HomeMonthlyGameSeries[];
  total: number[];
  wechat: HomeChannelTrend;
  douyin: HomeChannelTrend;
}

interface HomeActivitySeries {
  game_key: string;
  display_name: string;
  values: number[];
}

interface HomeActivityTrend {
  games: HomeActivitySeries[];
  total: number[];
}

interface HomeActivityWindow {
  buckets: string[];
  dau: HomeActivityTrend;
  ad_show: HomeActivityTrend;
}

interface HomeOnlineWindow {
  buckets: string[];
  games: HomeActivitySeries[];
  total: number[];
}

type ActivityMetric = 'dau' | 'ad';

interface HomeDauResponse {
  ok: boolean;
  date_key?: string;
  computed_at?: number;
  month_from_date?: string;
  month_t1_date?: string;
  daily_from_date?: string;
  month_t1_revenue_cny?: number;
  month_t1_wechat_revenue_cny?: number;
  month_t1_douyin_revenue_cny?: number;
  daily_trend?: HomeDailyTrend;
  monthly_trend?: HomeMonthlyTrend;
  today_total_dau?: number;
  today_total_ad_show?: number;
  activity_daily?: HomeActivityWindow;
  activity_monthly?: HomeActivityWindow;
  online_now?: number;
  online_today?: HomeOnlineWindow;
  games?: HomeGameDau[];
  error?: string;
}

const ACTIVITY_META: Record<
  ActivityMetric,
  { title: string; unit: string; color: string; empty: string }
> = {
  dau: { title: '总日活', unit: '人', color: '#0f766e', empty: '暂无日活' },
  ad: { title: '总曝光', unit: '次', color: '#c2410c', empty: '暂无曝光' },
};

const CHANNEL_META: Record<
  RevenueChannel,
  { title: string; color: string; empty: string }
> = {
  total: { title: '总收入', color: '#b45309', empty: '暂无总收益' },
  wechat: { title: '微信收入', color: '#1d4ed8', empty: '暂无微信收益' },
  douyin: { title: '抖音收入', color: '#7c3aed', empty: '暂无抖音收益' },
};

function formatCount(n: number): string {
  if (n >= 10_000) {
    const v = n / 10_000;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}万`;
  }
  return n.toLocaleString('zh-CN');
}

function formatYuan(n: number): string {
  if (n >= 10_000) {
    const v = n / 10_000;
    return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)}万`;
  }
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  if (!year || !month) return monthKey;
  return `${year.slice(2)}年${Number(month)}月`;
}

/** 日轴大约留 8 个刻度，并且始终画出第一天和最后一天。 */
function dailyAxisInterval(count: number): (index: number) => boolean {
  const last = Math.max(0, count - 1);
  const step = Math.max(1, Math.round(count / 8));
  return (index: number) => {
    if (index === 0 || index === last) return true;
    if (last - index < step) return false;
    return index % step === 0;
  };
}

function formatDayLabel(dateKey: string): string {
  const [, month, day] = dateKey.split('-');
  if (!month || !day) return dateKey;
  return `${Number(month)}/${Number(day)}`;
}

function barPct(value: number, max: number): number {
  return Math.round((value / Math.max(1, max)) * 100);
}

/** 在线曲线刻度：整点里的偶数小时，再加上第一个和最后一个点。 */
function clockAxisInterval(buckets: string[]): (index: number) => boolean {
  const last = Math.max(0, buckets.length - 1);
  return (index: number) => {
    if (index === 0 || index === last) return true;
    const time = (buckets[index] || '').split(' ').pop() || '';
    const [hour, minute] = time.split(':');
    if (minute !== '00') return false;
    return Number(hour) % 2 === 0;
  };
}

function pickChannelTrend(
  channel: RevenueChannel,
  daily: HomeDailyTrend | null,
  monthly: HomeMonthlyTrend | null,
  isDaily: boolean,
): { buckets: string[]; games: HomeMonthlyGameSeries[]; totals: number[] } {
  if (isDaily) {
    const source = daily;
    const branch = channel === 'wechat' ? source?.wechat : channel === 'douyin' ? source?.douyin : null;
    return {
      buckets: source?.days || [],
      games: branch?.games || source?.games || [],
      totals: branch?.total || source?.total || [],
    };
  }
  const source = monthly;
  const branch = channel === 'wechat' ? source?.wechat : channel === 'douyin' ? source?.douyin : null;
  return {
    buckets: source?.months || [],
    games: branch?.games || source?.games || [],
    totals: branch?.total || source?.total || [],
  };
}

function buildTrendChartOption(input: {
  color: string;
  isDaily: boolean;
  /** 今天的实时在线：横轴已经是「时:分」，点很密，不再画圆点 */
  clock?: boolean;
  buckets: string[];
  games: Array<{ display_name: string; values: number[] }>;
  totals: number[];
  legendSelected: Record<string, boolean> | null;
  formatValue: (value: number) => string;
}): EChartsOption {
  const selected: Record<string, boolean> = { 合计: true };
  for (const game of input.games) selected[game.display_name] = false;
  if (input.legendSelected) {
    for (const [name, on] of Object.entries(input.legendSelected)) {
      if (name in selected) selected[name] = on;
    }
  }
  return {
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value) =>
        typeof value === 'number' ? input.formatValue(value) : String(value ?? ''),
    },
    legend: {
      type: 'scroll',
      top: 0,
      right: 0,
      selected,
      selectedMode: true,
    },
    grid: { left: 4, right: input.clock || input.isDaily ? 18 : 8, top: 28, bottom: 2, containLabel: true },
    xAxis: {
      type: 'category',
      data: input.buckets,
      boundaryGap: false,
      axisLabel: {
        // 按天时不要自动抽稀，否则最后两天的刻度会被藏掉。按月标签较长，重叠的月份交给图表自己藏。
        hideOverlap: Boolean(input.clock) || !input.isDaily,
        interval: input.clock
          ? clockAxisInterval(input.buckets)
          : input.isDaily
            ? dailyAxisInterval(input.buckets.length)
            : 0,
        formatter: (value: string) =>
          input.clock ? value : input.isDaily ? formatDayLabel(value) : formatMonthLabel(value),
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      axisLabel: {
        formatter: (value: number) => (value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(value)),
      },
      splitLine: { lineStyle: { type: 'dashed' } },
    },
    series: [
      {
        name: '合计',
        type: 'line' as const,
        smooth: 0.35,
        showSymbol: !input.clock,
        symbolSize: input.clock ? 0 : input.isDaily ? 5 : 7,
        z: 3,
        lineStyle: { width: 3, type: 'solid' as const },
        itemStyle: { color: input.color },
        areaStyle: { opacity: 0.14 },
        data: input.totals,
      },
      ...input.games.map((game) => ({
        name: game.display_name,
        type: 'line' as const,
        smooth: 0.35,
        showSymbol: !input.clock,
        symbolSize: input.clock ? 0 : 6,
        data: game.values,
      })),
    ],
  };
}

function buildRevenueChartOption(input: {
  channel: RevenueChannel;
  isDaily: boolean;
  buckets: string[];
  games: HomeMonthlyGameSeries[];
  totals: number[];
  legendSelected: Record<string, boolean> | null;
}): EChartsOption {
  return buildTrendChartOption({
    color: CHANNEL_META[input.channel].color,
    isDaily: input.isDaily,
    buckets: input.buckets,
    games: input.games.map((game) => ({ display_name: game.display_name, values: game.revenue })),
    totals: input.totals,
    legendSelected: input.legendSelected,
    formatValue: (value) => `${formatYuan(value)} 元`,
  });
}

function PlatformMetric({
  kind,
  value,
  max,
}: {
  kind: 'dau' | 'ad' | 'rev';
  value: number;
  max: number;
}) {
  const label = kind === 'dau' ? '日活' : kind === 'ad' ? '曝光' : 'T-1';
  const display = kind === 'rev' ? formatYuan(value) : formatCount(value);
  return (
    <span className={`home-metric home-metric-${kind}`}>
      <span className="home-metric-head">
        <span className="home-metric-k">{label}</span>
        <span className="home-metric-v mono">{display}</span>
      </span>
      <span className="home-platform-bar-track" aria-hidden>
        <span className="home-platform-bar-fill" style={{ width: `${barPct(value, max)}%` }} />
      </span>
    </span>
  );
}

/**
 * 经分总览主页：各游戏今日微信/抖音日活与广告曝光，点击平台进入该游戏看板。
 */
export function HomePage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateKey, setDateKey] = useState('');
  const [computedAt, setComputedAt] = useState<number | null>(null);
  const [monthFromDate, setMonthFromDate] = useState('');
  const [monthT1Date, setMonthT1Date] = useState('');
  const [monthT1Revenue, setMonthT1Revenue] = useState(0);
  const [monthT1WechatRevenue, setMonthT1WechatRevenue] = useState(0);
  const [monthT1DouyinRevenue, setMonthT1DouyinRevenue] = useState(0);
  const [dailyFromDate, setDailyFromDate] = useState('');
  const [dailyTrend, setDailyTrend] = useState<HomeDailyTrend | null>(null);
  const [monthlyTrend, setMonthlyTrend] = useState<HomeMonthlyTrend | null>(null);
  const [todayTotalDau, setTodayTotalDau] = useState(0);
  const [todayTotalAdShow, setTodayTotalAdShow] = useState(0);
  const [activityDaily, setActivityDaily] = useState<HomeActivityWindow | null>(null);
  const [activityMonthly, setActivityMonthly] = useState<HomeActivityWindow | null>(null);
  const [onlineNow, setOnlineNow] = useState(0);
  const [onlineToday, setOnlineToday] = useState<HomeOnlineWindow | null>(null);
  const [revenueGranularity, setRevenueGranularity] = useState<RevenueGranularity>('day');
  const [legendSelected, setLegendSelected] = useState<Record<string, boolean> | null>(null);
  const [dauLegendSelected, setDauLegendSelected] = useState<Record<string, boolean> | null>(null);
  const [adLegendSelected, setAdLegendSelected] = useState<Record<string, boolean> | null>(null);
  const [onlineLegendSelected, setOnlineLegendSelected] = useState<Record<string, boolean> | null>(null);
  const [games, setGames] = useState<HomeGameDau[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<HomeDauResponse>('/api/realtime/home-dau');
      if (!data.ok) {
        throw new Error(data.error || '加载主页总览失败');
      }
      setDateKey(data.date_key || '');
      setComputedAt(data.computed_at ?? null);
      setMonthFromDate(data.month_from_date || '');
      setMonthT1Date(data.month_t1_date || '');
      setMonthT1Revenue(data.month_t1_revenue_cny ?? 0);
      setMonthT1WechatRevenue(data.month_t1_wechat_revenue_cny ?? 0);
      setMonthT1DouyinRevenue(data.month_t1_douyin_revenue_cny ?? 0);
      setDailyFromDate(data.daily_from_date || '');
      setDailyTrend(data.daily_trend || null);
      setMonthlyTrend(data.monthly_trend || null);
      setTodayTotalDau(data.today_total_dau ?? (data.games || []).reduce((sum, game) => sum + (game.total_dau || 0), 0));
      setTodayTotalAdShow(data.today_total_ad_show ?? (data.games || []).reduce((sum, game) => sum + (game.total_ad_show || 0), 0));
      setActivityDaily(data.activity_daily || null);
      setActivityMonthly(data.activity_monthly || null);
      setOnlineToday(data.online_today || null);
      setOnlineNow(
        data.online_now ??
          (data.online_today?.total?.length
            ? data.online_today.total[data.online_today.total.length - 1] || 0
            : 0),
      );
      setGames(data.games || []);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const maxTotal = Math.max(1, ...games.map((g) => g.total_dau));
  const isDaily = revenueGranularity === 'day';
  const monthHint =
    monthFromDate && monthT1Date ? `${monthFromDate} ~ ${monthT1Date}` : '当月截至昨天，不含今日';
  const chartHint = isDaily
    ? `${dailyFromDate && monthT1Date ? `${dailyFromDate} ~ ${monthT1Date}` : '截止昨天'} · 默认只看合计`
    : '默认只看合计 · 当月按 T-1 · 点图例可对比单款游戏';

  const monthByChannel: Record<RevenueChannel, number> = {
    total: monthT1Revenue,
    wechat: monthT1WechatRevenue,
    douyin: monthT1DouyinRevenue,
  };

  const chartOptions = useMemo(() => {
    const channels: RevenueChannel[] = ['total', 'wechat', 'douyin'];
    return Object.fromEntries(
      channels.map((channel) => {
        const picked = pickChannelTrend(channel, dailyTrend, monthlyTrend, isDaily);
        return [
          channel,
          buildRevenueChartOption({
            channel,
            isDaily,
            buckets: picked.buckets,
            games: picked.games,
            totals: picked.totals,
            legendSelected,
          }),
        ];
      }),
    ) as Record<RevenueChannel, EChartsOption>;
  }, [dailyTrend, isDaily, legendSelected, monthlyTrend]);

  const activityWindow = isDaily ? activityDaily : activityMonthly;
  const activityOptions = useMemo(() => {
    const metrics: ActivityMetric[] = ['dau', 'ad'];
    return Object.fromEntries(
      metrics.map((metric) => {
        const branch = metric === 'dau' ? activityWindow?.dau : activityWindow?.ad_show;
        const meta = ACTIVITY_META[metric];
        return [
          metric,
          buildTrendChartOption({
            color: meta.color,
            isDaily,
            buckets: activityWindow?.buckets || [],
            games: (branch?.games || []).map((game) => ({
              display_name: game.display_name,
              values: game.values || [],
            })),
            totals: branch?.total || [],
            legendSelected: metric === 'dau' ? dauLegendSelected : adLegendSelected,
            formatValue: (value) => `${formatCount(value)} ${meta.unit}`,
          }),
        ];
      }),
    ) as Record<ActivityMetric, EChartsOption>;
  }, [activityWindow, adLegendSelected, dauLegendSelected, isDaily]);

  const onlineOption = useMemo(
    () =>
      buildTrendChartOption({
        color: '#0369a1',
        isDaily: false,
        clock: true,
        buckets: onlineToday?.buckets || [],
        games: (onlineToday?.games || []).map((game) => ({
          display_name: game.display_name,
          values: game.values || [],
        })),
        totals: onlineToday?.total || [],
        legendSelected: onlineLegendSelected,
        formatValue: (value) => `${formatCount(value)} 人`,
      }),
    [onlineLegendSelected, onlineToday],
  );

  const todayByActivity: Record<ActivityMetric, number> = {
    dau: todayTotalDau,
    ad: todayTotalAdShow,
  };

  const openGamePlatform = (gameKey: string, platform: PlatformFilter) => {
    navigate(
      `/business/dashboard?game=${encodeURIComponent(gameKey)}&platform=${encodeURIComponent(platform)}&window=today`,
    );
  };

  return (
    <div className="home-page">
      <div className="home-topbar">
        <div className="home-toolbar-text">
          <Title level={4} className="home-heading">
            今日总览
          </Title>
          <Text type="secondary" className="home-sub">
            {dateKey || '—'} · 按日活降序 · 点平台进看板
          </Text>
        </div>
        <Space className="home-topbar-actions">
          <Text type="secondary" className="home-meta">
            {computedAt ? new Date(computedAt).toLocaleTimeString('zh-CN') : '—'}
          </Text>
          <Button size="small" onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <div className="home-month-chart">
        <div className="home-month-chart-head">
          <div className="home-month-chart-head-left">
            <span className="home-month-chart-title">
              {isDaily ? '近一月日收益 · T-1' : '近一年月度收益'}
            </span>
            <Text type="secondary" className="home-month-chart-hint">
              {chartHint}
            </Text>
          </div>
          <Segmented
            size="small"
            value={revenueGranularity}
            options={[
              { label: '按天', value: 'day' },
              { label: '按月', value: 'month' },
            ]}
            onChange={(next) => setRevenueGranularity(next as RevenueGranularity)}
          />
        </div>
        <div className="home-revenue-grid">
          {(['total', 'wechat', 'douyin'] as const).map((channel) => {
            const meta = CHANNEL_META[channel];
            const picked = pickChannelTrend(channel, dailyTrend, monthlyTrend, isDaily);
            return (
              <section key={channel} className={`home-revenue-panel home-revenue-${channel}`}>
                <div className="home-revenue-panel-head">
                  <div className="home-revenue-panel-title-row">
                    <span className="home-revenue-panel-title">{meta.title}</span>
                    <span className="home-revenue-panel-num mono">{formatYuan(monthByChannel[channel])}</span>
                    <span className="home-revenue-panel-unit">元</span>
                  </div>
                  <Text type="secondary" className="home-revenue-panel-hint">
                    当月 T-1 · {monthHint}
                  </Text>
                </div>
                {picked.buckets.length ? (
                  <ReactECharts
                    option={chartOptions[channel]}
                    height={148}
                    framed={false}
                    onEvents={{
                      legendselectchanged: (event: { selected?: Record<string, boolean> }) => {
                        setLegendSelected(event.selected || null);
                      },
                    }}
                  />
                ) : (
                  <div className="home-month-chart-empty">{isDaily ? meta.empty : meta.empty}</div>
                )}
              </section>
            );
          })}
        </div>
        <div className="home-activity-head">
          <span className="home-month-chart-title">全部游戏 · 日活、曝光与在线</span>
          <Text type="secondary" className="home-month-chart-hint">
            {isDaily
              ? '日活和曝光是近 30 天含今天 · 在线是近 24 小时 · 默认只看合计'
              : '日活和曝光按月 · 在线仍是近 24 小时 · 默认只看合计'}
          </Text>
        </div>
        <div className="home-activity-grid">
          {(['dau', 'ad'] as const).map((metric) => {
            const meta = ACTIVITY_META[metric];
            const buckets = activityWindow?.buckets || [];
            return (
              <section key={metric} className={`home-revenue-panel home-activity-${metric}`}>
                <div className="home-revenue-panel-head">
                  <div className="home-revenue-panel-title-row">
                    <span className="home-revenue-panel-title">{meta.title}</span>
                    <span className="home-revenue-panel-num mono">{formatCount(todayByActivity[metric])}</span>
                    <span className="home-revenue-panel-unit">{meta.unit}</span>
                  </div>
                  <Text type="secondary" className="home-revenue-panel-hint">
                    今日 · 全部游戏
                  </Text>
                </div>
                {buckets.length ? (
                  <ReactECharts
                    option={activityOptions[metric]}
                    height={148}
                    framed={false}
                    onEvents={{
                      legendselectchanged: (event: { selected?: Record<string, boolean> }) => {
                        const selected = event.selected || null;
                        if (metric === 'dau') setDauLegendSelected(selected);
                        else setAdLegendSelected(selected);
                      },
                    }}
                  />
                ) : (
                  <div className="home-month-chart-empty">{meta.empty}</div>
                )}
              </section>
            );
          })}
          <section className="home-revenue-panel home-activity-online">
            <div className="home-revenue-panel-head">
              <div className="home-revenue-panel-title-row">
                <span className="home-revenue-panel-title">当前在线</span>
                <span className="home-revenue-panel-num mono">{formatCount(onlineNow)}</span>
                <span className="home-revenue-panel-unit">人</span>
              </div>
              <Text type="secondary" className="home-revenue-panel-hint">
                近 24 小时 · 最右是此刻
              </Text>
            </div>
            {onlineToday?.buckets.length ? (
              <ReactECharts
                option={onlineOption}
                height={148}
                framed={false}
                onEvents={{
                  legendselectchanged: (event: { selected?: Record<string, boolean> }) => {
                    setOnlineLegendSelected(event.selected || null);
                  },
                }}
              />
            ) : (
              <div className="home-month-chart-empty">暂无在线</div>
            )}
          </section>
        </div>
      </div>

      {error && (
        <Alert type="error" showIcon className="home-alert" message={error} />
      )}

      <Spin spinning={loading && games.length === 0}>
        <div className="home-game-grid">
          {games.map((game) => {
            const heat = Math.min(1, game.total_dau / maxTotal);
            const platformDauMax = Math.max(1, ...game.platforms.map((p) => p.dau));
            const platformAdMax = Math.max(1, ...game.platforms.map((p) => p.ad_show_cnt || 0));
            const platformRevMax = Math.max(1, ...game.platforms.map((p) => p.t1_revenue_cny || 0));
            return (
              <article
                key={game.game_key}
                className="home-game-card"
                style={{ ['--home-heat' as string]: String(heat) }}
              >
                <header className="home-game-card-head">
                  <div className="home-game-card-title-row">
                    <GameIcon gameKey={game.game_key} name={game.display_name} />
                    <h2 className="home-game-name">{game.display_name}</h2>
                  </div>
                  <div className="home-game-kpis">
                    <div className="home-game-kpi">
                      <span className="home-game-kpi-num">{formatCount(game.total_dau)}</span>
                      <span className="home-game-kpi-label">总日活</span>
                    </div>
                    <div className="home-game-kpi home-game-kpi-ad">
                      <span className="home-game-kpi-num">{formatCount(game.total_ad_show || 0)}</span>
                      <span className="home-game-kpi-label">总曝光</span>
                    </div>
                    <div className="home-game-kpi home-game-kpi-rev">
                      <span className="home-game-kpi-num">{formatYuan(game.month_t1_revenue_cny || 0)}</span>
                      <span className="home-game-kpi-label">当月T-1</span>
                    </div>
                  </div>
                </header>

                <div className="home-platform-list">
                  {game.platforms.map((p) => (
                    <button
                      key={p.platform}
                      type="button"
                      className={`home-platform-row home-platform-${p.platform}`}
                      aria-label={`${p.label} 日活 ${formatCount(p.dau)}，曝光 ${formatCount(p.ad_show_cnt || 0)}，T-1 ${formatYuan(p.t1_revenue_cny || 0)} 元`}
                      onClick={() => openGamePlatform(game.game_key, p.platform)}
                    >
                      <span className="home-platform-label">{p.label}</span>
                      <PlatformMetric kind="dau" value={p.dau} max={platformDauMax} />
                      <PlatformMetric kind="ad" value={p.ad_show_cnt || 0} max={platformAdMax} />
                      <PlatformMetric kind="rev" value={p.t1_revenue_cny || 0} max={platformRevMax} />
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
        {!loading && games.length === 0 && !error && (
          <div className="home-empty">暂无已接入 SDK 的游戏</div>
        )}
      </Spin>
    </div>
  );
}

import { CrownFilled, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import { Alert, Button, Segmented, Spin } from 'antd';
import type { EChartsOption } from 'echarts';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { CHANNEL_PLATFORMS, PLATFORM_LABEL, type PlatformFilter } from '../../shared/platforms';
import ReactECharts from '../components/AnalyticsChart';
import { GameIcon } from '../components/GameIcon';
import { fetchJson } from '../fetchJson';

type RevenueGranularity = 'day' | 'month';
type RevenueChannel = 'total' | 'wechat' | 'douyin';

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
  dau: { title: '总日活', unit: '人', color: '#14b8a6', empty: '暂无日活' },
  ad: { title: '总曝光', unit: '次', color: '#fb923c', empty: '暂无曝光' },
};

const CHANNEL_META: Record<
  RevenueChannel,
  { title: string; color: string; empty: string }
> = {
  total: { title: '总收入', color: '#fbbf25', empty: '暂无总收益' },
  wechat: { title: '微信收入', color: '#12b982', empty: '暂无微信收益' },
  douyin: { title: '抖音收入', color: '#f43f5e', empty: '暂无抖音收益' },
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

function sumMoney(values: number[] | undefined): number {
  return Math.round((values || []).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0) * 100) / 100;
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
      backgroundColor: 'rgba(11, 18, 32, 0.95)',
      borderColor: 'rgba(251, 191, 36, 0.32)',
      textStyle: { color: '#f1f5f9', fontSize: 12 },
      extraCssText: 'border-radius:10px;box-shadow:0 12px 28px rgba(0,0,0,0.45);backdrop-filter:blur(8px);',
      valueFormatter: (value) =>
        typeof value === 'number' ? input.formatValue(value) : String(value ?? ''),
    },
    legend: {
      type: 'scroll',
      top: 0,
      right: 0,
      itemHeight: 6,
      itemWidth: 10,
      itemGap: 8,
      inactiveColor: 'rgba(148, 163, 184, 0.38)',
      textStyle: { fontSize: 10.5, color: '#cbd5e2' },
      pageIconColor: '#fbbf24',
      pageIconInactiveColor: '#334156',
      pageIconSize: 9,
      pageTextStyle: { color: '#95a4b8', fontSize: 10 },
      selected,
      selectedMode: true,
    },
    grid: { left: 4, right: input.clock || input.isDaily ? 14 : 8, top: 20, bottom: 2, containLabel: true },
    xAxis: {
      type: 'category',
      data: input.buckets,
      boundaryGap: false,
      axisLine: { show: true, lineStyle: { color: 'rgba(148, 163, 184, 0.16)' } },
      axisLabel: {
        fontSize: 10,
        margin: 5,
        color: '#95a4b8',
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
      splitNumber: 2,
      axisLabel: {
        fontSize: 10,
        margin: 6,
        color: '#95a4b8',
        formatter: (value: number) => (value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(value)),
      },
      splitLine: { lineStyle: { type: 'dashed', color: 'rgba(148, 163, 184, 0.12)' } },
    },
    series: [
      {
        name: '合计',
        type: 'line' as const,
        smooth: 0.36,
        showSymbol: false,
        symbolSize: 5,
        z: 3,
        lineStyle: { width: 2.5, type: 'solid' as const, color: input.color },
        itemStyle: { color: input.color },
        areaStyle: { opacity: 0.24 },
        data: input.totals,
      },
      ...input.games.map((game) => ({
        name: game.display_name,
        type: 'line' as const,
        smooth: 0.35,
        showSymbol: false,
        symbolSize: 4,
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

function SheetNumber({
  kind,
  value,
  inverted = false,
}: {
  kind: 'dau' | 'ad' | 'rev';
  value: number;
  inverted?: boolean;
}) {
  const display = kind === 'rev' ? formatYuan(value) : formatCount(value);
  return (
    <span
      className={`home-sheet-num home-sheet-num-${kind}${value === 0 ? ' is-zero' : ''}${
        inverted ? ' is-inverted' : ''
      }`}
    >
      {display}
    </span>
  );
}

/**
 * 卡片铭牌右侧内嵌 14 日微缩走势图：优先展示 T-1 收益曲线（鎏金），若无收益则回退日活曲线（翠青）。
 */
function GameSparkline({
  values,
  tone,
  title,
}: {
  values: number[];
  tone: 'gold' | 'teal' | 'muted';
  title: string;
}) {
  const gradId = useId().replace(/:/g, '');
  const width = 62;
  const height = 22;
  const padX = 2;
  const padY = 3;
  const recent = values.slice(-14);
  const maxVal = Math.max(0, ...recent);

  if (recent.length < 2 || maxVal <= 0 || tone === 'muted') {
    return (
      <svg
        className="home-sparkline home-sparkline-flat"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-label={title}
      >
        <line
          x1={padX}
          y1={height - 5}
          x2={width - padX}
          y2={height - 5}
          stroke="rgba(226, 232, 240, 0.28)"
          strokeWidth="1.5"
          strokeDasharray="2.5 2.5"
        />
      </svg>
    );
  }

  const strokeColor = tone === 'gold' ? '#fbbf24' : '#2dd4bf';
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const pts = recent.map((v, idx) => {
    const x = padX + (idx / (recent.length - 1)) * innerW;
    const y = padY + innerH - (Math.max(0, v) / maxVal) * innerH;
    return [x, y] as const;
  });

  const linePath = pts
    .map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${pts[pts.length - 1][0].toFixed(1)},${(height - 1).toFixed(
    1,
  )} L${pts[0][0].toFixed(1)},${(height - 1).toFixed(1)} Z`;
  const [lastX, lastY] = pts[pts.length - 1];

  return (
    <svg
      className="home-sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.45" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path
        d={linePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r="2.3" fill={strokeColor} />
    </svg>
  );
}

function calcPlatformHeatPct(
  p: HomePlatformDau,
  maxDau: number,
  maxAd: number,
  maxRev: number,
): number {
  if (p.dau <= 0 && (p.ad_show_cnt || 0) <= 0 && (p.t1_revenue_cny || 0) <= 0) {
    return 0;
  }
  const dauRatio = maxDau > 0 ? p.dau / maxDau : 0;
  const revRatio = maxRev > 0 ? (p.t1_revenue_cny || 0) / maxRev : 0;
  const adRatio = maxAd > 0 ? (p.ad_show_cnt || 0) / maxAd : 0;
  const dominant = Math.max(dauRatio, revRatio * 0.9, adRatio * 0.75);
  return Math.max(14, Math.min(100, Math.round(dominant * 100)));
}

/**
 * 经分总览主页：深墨曜石全局遥测舱 + 13 款游戏高定分渠道矩阵 + 全盘五渠道母卡。
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
      setTodayTotalDau(
        data.today_total_dau ?? (data.games || []).reduce((sum, game) => sum + (game.total_dau || 0), 0),
      );
      setTodayTotalAdShow(
        data.today_total_ad_show ??
          (data.games || []).reduce((sum, game) => sum + (game.total_ad_show || 0), 0),
      );
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

  const isDaily = revenueGranularity === 'day';
  const monthHint =
    monthFromDate && monthT1Date ? `${monthFromDate.slice(5)}~${monthT1Date.slice(5)}` : '当月T-1';
  const chartScopeHint = isDaily
    ? `${dailyFromDate ? `${dailyFromDate.slice(5)}~${(monthT1Date || '').slice(5)}` : '近30天'} · 点图例叠加单游`
    : '近12个月 · 点图例叠加单游';

  const monthByChannel: Record<RevenueChannel, number> = {
    total: monthT1Revenue,
    wechat: monthT1WechatRevenue,
    douyin: monthT1DouyinRevenue,
  };
  const yearByChannel: Record<RevenueChannel, number> = {
    total: sumMoney(monthlyTrend?.total),
    wechat: sumMoney(monthlyTrend?.wechat.total),
    douyin: sumMoney(monthlyTrend?.douyin.total),
  };
  const headlineByChannel = isDaily ? monthByChannel : yearByChannel;
  const yearMonths = monthlyTrend?.months || [];
  const yearHint = yearMonths.length
    ? `${yearMonths[0]}~${yearMonths[yearMonths.length - 1]}`
    : '近12个月';

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
        color: '#38bdf9',
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

  /** 每款游戏的近 14 日微缩曲线与当前实时在线人数索引 */
  const gamePulseMap = useMemo(() => {
    const revByGame = new Map<string, number[]>();
    for (const g of dailyTrend?.games || []) {
      revByGame.set(g.game_key, g.revenue || []);
    }
    const dauByGame = new Map<string, number[]>();
    for (const g of activityDaily?.dau.games || []) {
      dauByGame.set(g.game_key, g.values || []);
    }
    const onlineByGame = new Map<string, number>();
    for (const g of onlineToday?.games || []) {
      const vals = g.values || [];
      onlineByGame.set(g.game_key, vals.length ? vals[vals.length - 1] || 0 : 0);
    }
    return { revByGame, dauByGame, onlineByGame };
  }, [activityDaily, dailyTrend, onlineToday]);

  /** 全盘五渠道纵向汇总（供第 14 格黑曜石母卡展示） */
  const portfolioPlatforms = useMemo(() => {
    return CHANNEL_PLATFORMS.map((plat) => {
      let dau = 0;
      let ad = 0;
      let rev = 0;
      let leadGameKey = games[0]?.game_key || 'huahua';
      let leadScore = -1;
      for (const g of games) {
        const row = g.platforms.find((item) => item.platform === plat);
        if (!row) continue;
        dau += row.dau || 0;
        ad += row.ad_show_cnt || 0;
        rev += row.t1_revenue_cny || 0;
        const score = (row.dau || 0) * 1000 + (row.t1_revenue_cny || 0);
        if (score > leadScore) {
          leadScore = score;
          leadGameKey = g.game_key;
        }
      }
      return {
        platform: plat,
        label: PLATFORM_LABEL[plat],
        dau,
        ad_show_cnt: ad,
        t1_revenue_cny: Math.round(rev * 100) / 100,
        leadGameKey,
      };
    });
  }, [games]);

  const activeGameCount = useMemo(
    () =>
      games.filter(
        (g) => g.total_dau > 0 || (g.total_ad_show || 0) > 0 || (g.month_t1_revenue_cny || 0) > 0,
      ).length,
    [games],
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

  const openGamePrimary = (game: HomeGameDau) => {
    const best = [...game.platforms].sort(
      (a, b) =>
        b.dau - a.dau ||
        (b.t1_revenue_cny || 0) - (a.t1_revenue_cny || 0) ||
        (b.ad_show_cnt || 0) - (a.ad_show_cnt || 0),
    )[0];
    openGamePlatform(game.game_key, best?.platform || 'wechat');
  };

  const portfolioMaxDau = Math.max(1, ...portfolioPlatforms.map((p) => p.dau));
  const portfolioMaxAd = Math.max(1, ...portfolioPlatforms.map((p) => p.ad_show_cnt));
  const portfolioMaxRev = Math.max(1, ...portfolioPlatforms.map((p) => p.t1_revenue_cny));

  return (
    <div className="home-page">
      <section className="home-command-deck">
        <div className="home-deck-ribbon">
          <div className="home-deck-ribbon-left">
            <span className="home-live-pill">
              <span className="home-live-dot" aria-hidden />
              <span>今日总览</span>
              <span className="home-live-date mono">{dateKey || '—'}</span>
            </span>
            <div className="home-deck-pills">
              <span className="home-deck-stat home-deck-stat-gold">
                <span className="home-deck-stat-k">{isDaily ? '当月T-1总收' : '近一年总收'}</span>
                <span className="home-deck-stat-v mono">¥{formatYuan(headlineByChannel.total)}</span>
              </span>
              <span className="home-deck-stat home-deck-stat-teal">
                <span className="home-deck-stat-k">今日总日活</span>
                <span className="home-deck-stat-v mono">{formatCount(todayTotalDau)}</span>
              </span>
              <span className="home-deck-stat home-deck-stat-warm">
                <span className="home-deck-stat-k">今日总曝光</span>
                <span className="home-deck-stat-v mono">{formatCount(todayTotalAdShow)}</span>
              </span>
              <span className="home-deck-stat home-deck-stat-sky">
                <span className="home-deck-stat-k">实时在线</span>
                <span className="home-deck-stat-v mono">{formatCount(onlineNow)}人</span>
              </span>
            </div>
            <span className="home-deck-hint">{chartScopeHint}</span>
          </div>

          <div className="home-deck-ribbon-right">
            <Segmented
              size="small"
              className="home-deck-segmented"
              value={revenueGranularity}
              options={[
                { label: '按天', value: 'day' },
                { label: '按月', value: 'month' },
              ]}
              onChange={(next) => setRevenueGranularity(next as RevenueGranularity)}
            />
            <span className="home-deck-clock mono">
              {computedAt ? new Date(computedAt).toLocaleTimeString('zh-CN') : '—'}
            </span>
            <Button
              size="small"
              className="home-deck-refresh"
              icon={<ReloadOutlined />}
              onClick={() => void load()}
              loading={loading}
            >
              刷新
            </Button>
          </div>
        </div>

        <div className="home-telemetry-board">
          <div className="home-revenue-grid">
            {(['total', 'wechat', 'douyin'] as const).map((channel) => {
              const meta = CHANNEL_META[channel];
              const picked = pickChannelTrend(channel, dailyTrend, monthlyTrend, isDaily);
              return (
                <section key={channel} className={`home-revenue-panel home-revenue-${channel}`}>
                  <div className="home-revenue-panel-head">
                    <div className="home-revenue-panel-title-row">
                      <span className="home-revenue-panel-dot" aria-hidden />
                      <span className="home-revenue-panel-title">{meta.title}</span>
                      <span className="home-revenue-panel-num mono">
                        {formatYuan(headlineByChannel[channel])}
                      </span>
                      <span className="home-revenue-panel-unit">元</span>
                    </div>
                    <span className="home-revenue-panel-scope mono">
                      {isDaily ? monthHint : yearHint}
                    </span>
                  </div>
                  {picked.buckets.length ? (
                    <ReactECharts
                      option={chartOptions[channel]}
                      height={102}
                      framed={false}
                      onEvents={{
                        legendselectchanged: (event: { selected?: Record<string, boolean> }) => {
                          setLegendSelected(event.selected || null);
                        },
                      }}
                    />
                  ) : (
                    <div className="home-month-chart-empty">{meta.empty}</div>
                  )}
                </section>
              );
            })}
          </div>

          <div className="home-activity-grid">
            {(['dau', 'ad'] as const).map((metric) => {
              const meta = ACTIVITY_META[metric];
              const buckets = activityWindow?.buckets || [];
              return (
                <section key={metric} className={`home-revenue-panel home-activity-${metric}`}>
                  <div className="home-revenue-panel-head">
                    <div className="home-revenue-panel-title-row">
                      <span className="home-revenue-panel-dot" aria-hidden />
                      <span className="home-revenue-panel-title">{meta.title}</span>
                      <span className="home-revenue-panel-num mono">
                        {formatCount(todayByActivity[metric])}
                      </span>
                      <span className="home-revenue-panel-unit">{meta.unit}</span>
                    </div>
                    <span className="home-revenue-panel-scope">
                      {isDaily ? '今日 · 近30天趋势' : '今日 · 月度趋势'}
                    </span>
                  </div>
                  {buckets.length ? (
                    <ReactECharts
                      option={activityOptions[metric]}
                      height={102}
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
                  <span className="home-revenue-panel-dot" aria-hidden />
                  <span className="home-revenue-panel-title">当前在线</span>
                  <span className="home-revenue-panel-num mono">{formatCount(onlineNow)}</span>
                  <span className="home-revenue-panel-unit">人</span>
                </div>
                <span className="home-revenue-panel-scope">近24小时 · 右端此刻</span>
              </div>
              {onlineToday?.buckets.length ? (
                <ReactECharts
                  option={onlineOption}
                  height={102}
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
      </section>

      {error && <Alert type="error" showIcon className="home-alert" message={error} />}

      <Spin spinning={loading && games.length === 0}>
        <div className="home-game-grid">
          {games.map((game, index) => {
            const rank = index + 1;
            const isActive =
              game.total_dau > 0 ||
              (game.total_ad_show || 0) > 0 ||
              (game.month_t1_revenue_cny || 0) > 0;
            const tierClass =
              rank === 1
                ? 'is-rank-1'
                : rank === 2
                  ? 'is-rank-2'
                  : rank === 3
                    ? 'is-rank-3'
                    : isActive
                      ? 'is-active'
                      : 'is-quiet';

            const revSeries = gamePulseMap.revByGame.get(game.game_key) || [];
            const dauSeries = gamePulseMap.dauByGame.get(game.game_key) || [];
            const hasRecentRev = revSeries.slice(-14).some((v) => v > 0);
            const hasRecentDau = dauSeries.slice(-14).some((v) => v > 0);
            const sparkValues = hasRecentRev ? revSeries : dauSeries;
            const sparkTone: 'gold' | 'teal' | 'muted' = hasRecentRev
              ? 'gold'
              : hasRecentDau
                ? 'teal'
                : 'muted';
            const sparkTitle = hasRecentRev
              ? `${game.display_name} 近14日T-1收益走势`
              : hasRecentDau
                ? `${game.display_name} 近14日日活走势`
                : `${game.display_name} 近期暂无波动`;

            const gameOnline = gamePulseMap.onlineByGame.get(game.game_key) || 0;
            const platMaxDau = Math.max(0, ...game.platforms.map((p) => p.dau));
            const platMaxAd = Math.max(0, ...game.platforms.map((p) => p.ad_show_cnt || 0));
            const platMaxRev = Math.max(0, ...game.platforms.map((p) => p.t1_revenue_cny || 0));

            return (
              <article key={game.game_key} className={`home-game-card ${tierClass}`}>
                <button
                  type="button"
                  className="home-card-banner"
                  onClick={() => openGamePrimary(game)}
                  title={`进入 ${game.display_name} 经营看板`}
                >
                  <div className="home-card-banner-left">
                    <span className="home-rank-badge mono">
                      {rank <= 3 ? <CrownFilled className="home-rank-crown" /> : null}
                      <span>{rank <= 3 ? `TOP ${rank}` : `#${rank}`}</span>
                    </span>
                    <GameIcon gameKey={game.game_key} name={game.display_name} />
                    <div className="home-card-title-wrap">
                      <h2 className="home-game-name">{game.display_name}</h2>
                      {gameOnline > 0 ? (
                        <span className="home-card-online mono">
                          <i aria-hidden />
                          {gameOnline}在线
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="home-card-banner-right">
                    <GameSparkline values={sparkValues} tone={sparkTone} title={sparkTitle} />
                  </div>
                </button>

                <div className="home-card-summary">
                  <div className="home-sheet-grid home-sheet-cols" aria-hidden>
                    <span className="home-sheet-col-first">渠道</span>
                    <span>总日活</span>
                    <span>总曝光</span>
                    <span>当月T-1</span>
                  </div>
                  <div className="home-sheet-grid home-sheet-total">
                    <span className="home-sheet-tag">合计</span>
                    <SheetNumber kind="dau" value={game.total_dau} />
                    <SheetNumber kind="ad" value={game.total_ad_show || 0} />
                    <SheetNumber kind="rev" value={game.month_t1_revenue_cny || 0} />
                  </div>
                </div>

                <div className="home-platform-list">
                  {game.platforms.map((p) => {
                    const pct = calcPlatformHeatPct(p, platMaxDau, platMaxAd, platMaxRev);
                    const hasData = pct > 0;
                    return (
                      <button
                        key={p.platform}
                        type="button"
                        className={`home-sheet-grid home-sheet-row home-platform-${p.platform}${
                          hasData ? ' has-data' : ' is-idle'
                        }`}
                        style={{ ['--plat-pct' as string]: `${pct}%` }}
                        aria-label={`${p.label} 日活 ${formatCount(p.dau)}，曝光 ${formatCount(
                          p.ad_show_cnt || 0,
                        )}，T-1 ${formatYuan(p.t1_revenue_cny || 0)} 元`}
                        onClick={() => openGamePlatform(game.game_key, p.platform)}
                      >
                        <span className="home-platform-label">
                          <i className="home-platform-dot" aria-hidden />
                          <span>{p.label}</span>
                        </span>
                        <SheetNumber kind="dau" value={p.dau} />
                        <SheetNumber kind="ad" value={p.ad_show_cnt || 0} />
                        <SheetNumber kind="rev" value={p.t1_revenue_cny || 0} />
                      </button>
                    );
                  })}
                </div>
              </article>
            );
          })}

          {games.length > 0 && (
            <aside className="home-game-card home-portfolio-card" aria-label="全盘五渠道总计">
              <div className="home-card-banner home-portfolio-banner">
                <div className="home-card-banner-left">
                  <span className="home-rank-badge home-portfolio-badge mono">ALL</span>
                  <div className="home-card-title-wrap">
                    <h2 className="home-game-name">全盘渠道总计</h2>
                    <span className="home-portfolio-sub mono">
                      活跃 {activeGameCount}/{games.length} 款
                    </span>
                  </div>
                </div>
                <RightOutlined className="home-portfolio-arrow" />
              </div>

              <div className="home-card-summary home-portfolio-summary">
                <div className="home-sheet-grid home-sheet-cols" aria-hidden>
                  <span className="home-sheet-col-first">渠道</span>
                  <span>总日活</span>
                  <span>总曝光</span>
                  <span>当月T-1</span>
                </div>
                <div className="home-sheet-grid home-sheet-total">
                  <span className="home-sheet-tag">全盘</span>
                  <SheetNumber kind="dau" value={todayTotalDau} inverted />
                  <SheetNumber kind="ad" value={todayTotalAdShow} inverted />
                  <SheetNumber kind="rev" value={monthT1Revenue} inverted />
                </div>
              </div>

              <div className="home-platform-list home-portfolio-list">
                {portfolioPlatforms.map((p) => {
                  const pct = calcPlatformHeatPct(
                    p,
                    portfolioMaxDau,
                    portfolioMaxAd,
                    portfolioMaxRev,
                  );
                  return (
                    <button
                      key={p.platform}
                      type="button"
                      className={`home-sheet-grid home-sheet-row home-portfolio-row home-platform-${
                        p.platform
                      }${pct > 0 ? ' has-data' : ' is-idle'}`}
                      style={{ ['--plat-pct' as string]: `${pct}%` }}
                      onClick={() => openGamePlatform(p.leadGameKey, p.platform)}
                      title={`进入 ${p.label} 头部游戏看板`}
                    >
                      <span className="home-platform-label">
                        <i className="home-platform-dot" aria-hidden />
                        <span>{p.label}</span>
                      </span>
                      <SheetNumber kind="dau" value={p.dau} inverted />
                      <SheetNumber kind="ad" value={p.ad_show_cnt} inverted />
                      <SheetNumber kind="rev" value={p.t1_revenue_cny} inverted />
                    </button>
                  );
                })}
              </div>
            </aside>
          )}
        </div>
        {!loading && games.length === 0 && !error && (
          <div className="home-empty">暂无已接入 SDK 的游戏</div>
        )}
      </Spin>
    </div>
  );
}

import { Alert, Button, Segmented, Space, Spin, Typography } from 'antd';
import type { EChartsOption } from 'echarts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { PlatformFilter } from '../../shared/platforms';
import ReactECharts from '../components/AnalyticsChart';
import { fetchJson } from '../fetchJson';

type RevenueGranularity = 'day' | 'month';

const { Text, Title } = Typography;

interface HomePlatformDau {
  platform: PlatformFilter;
  label: string;
  dau: number;
  ad_show_cnt: number;
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

interface HomeMonthlyTrend {
  months: string[];
  games: HomeMonthlyGameSeries[];
  total: number[];
}

interface HomeDailyTrend {
  days: string[];
  games: HomeMonthlyGameSeries[];
  total: number[];
}

interface HomeDauResponse {
  ok: boolean;
  date_key?: string;
  computed_at?: number;
  month_from_date?: string;
  month_t1_date?: string;
  daily_from_date?: string;
  month_t1_revenue_cny?: number;
  daily_trend?: HomeDailyTrend;
  monthly_trend?: HomeMonthlyTrend;
  games?: HomeGameDau[];
  error?: string;
}

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

function formatDayLabel(dateKey: string): string {
  const [, month, day] = dateKey.split('-');
  if (!month || !day) return dateKey;
  return `${Number(month)}/${Number(day)}`;
}

function barPct(value: number, max: number): number {
  return Math.round((value / Math.max(1, max)) * 100);
}

function PlatformMetric({
  kind,
  value,
  max,
}: {
  kind: 'dau' | 'ad';
  value: number;
  max: number;
}) {
  return (
    <span className={`home-metric home-metric-${kind}`}>
      <span className="home-metric-head">
        <span className="home-metric-k">{kind === 'dau' ? '日活' : '曝光'}</span>
        <span className="home-metric-v mono">{formatCount(value)}</span>
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
  const [dailyFromDate, setDailyFromDate] = useState('');
  const [dailyTrend, setDailyTrend] = useState<HomeDailyTrend | null>(null);
  const [monthlyTrend, setMonthlyTrend] = useState<HomeMonthlyTrend | null>(null);
  const [revenueGranularity, setRevenueGranularity] = useState<RevenueGranularity>('day');
  const [legendSelected, setLegendSelected] = useState<Record<string, boolean> | null>(null);
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
      setDailyFromDate(data.daily_from_date || '');
      setDailyTrend(data.daily_trend || null);
      setMonthlyTrend(data.monthly_trend || null);
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
  const revenueChartOption = useMemo<EChartsOption>(() => {
    const buckets = isDaily ? dailyTrend?.days || [] : monthlyTrend?.months || [];
    const gameSeries = isDaily ? dailyTrend?.games || [] : monthlyTrend?.games || [];
    const totals = isDaily ? dailyTrend?.total || [] : monthlyTrend?.total || [];
    const selected: Record<string, boolean> = { 合计: true };
    for (const game of gameSeries) selected[game.display_name] = false;
    if (legendSelected) {
      for (const [name, on] of Object.entries(legendSelected)) {
        if (name in selected) selected[name] = on;
      }
    }
    return {
      tooltip: {
        trigger: 'axis',
        valueFormatter: (value) =>
          typeof value === 'number' ? `${formatYuan(value)} 元` : String(value ?? ''),
      },
      legend: {
        type: 'scroll',
        top: 0,
        right: 8,
        selected,
        selectedMode: true,
      },
      grid: { left: 8, right: 12, top: 24, bottom: 2, containLabel: true },
      xAxis: {
        type: 'category',
        data: buckets,
        boundaryGap: false,
        axisLabel: {
          hideOverlap: true,
          formatter: (value: string) => (isDaily ? formatDayLabel(value) : formatMonthLabel(value)),
        },
      },
      yAxis: {
        type: 'value',
        name: '元',
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
          showSymbol: true,
          symbolSize: isDaily ? 6 : 8,
          z: 3,
          lineStyle: { width: 3, type: 'solid' as const },
          itemStyle: { color: '#b45309' },
          areaStyle: { opacity: 0.16 },
          data: totals,
        },
        ...gameSeries.map((game) => ({
          name: game.display_name,
          type: 'line' as const,
          smooth: 0.35,
          showSymbol: true,
          symbolSize: 7,
          data: game.revenue,
        })),
      ],
    };
  }, [dailyTrend, isDaily, legendSelected, monthlyTrend]);

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
        <div className="home-month-revenue" aria-label="当月截至昨天总收益">
          <div className="home-month-revenue-main">
            <span className="home-month-revenue-label">当月 T-1</span>
            <span className="home-month-revenue-num mono">{formatYuan(monthT1Revenue)}</span>
            <span className="home-month-revenue-unit">元</span>
          </div>
          <Text type="secondary" className="home-month-revenue-hint">
            {monthFromDate && monthT1Date
              ? `${monthFromDate} ~ ${monthT1Date}`
              : '微信流量主真实收入，不含今日'}
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
              {isDaily
                ? `${dailyFromDate && monthT1Date ? `${dailyFromDate} ~ ${monthT1Date}` : '截止昨天'} · 默认只看合计`
                : '默认只看合计 · 当月按 T-1 · 点图例可对比单款游戏'}
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
        {(isDaily ? dailyTrend?.days.length : monthlyTrend?.months.length) ? (
          <ReactECharts
            option={revenueChartOption}
            height={148}
            framed={false}
            onEvents={{
              legendselectchanged: (event: { selected?: Record<string, boolean> }) => {
                setLegendSelected(event.selected || null);
              },
            }}
          />
        ) : (
          <div className="home-month-chart-empty">{isDaily ? '暂无日收益' : '暂无月度收益'}</div>
        )}
      </div>

      {error && (
        <Alert type="error" showIcon className="home-alert" message={error} />
      )}

      <Spin spinning={loading && games.length === 0}>
        <div className="home-game-grid">
          {games.map((game, index) => {
            const rank = index + 1;
            const heat = Math.min(1, game.total_dau / maxTotal);
            const platformDauMax = Math.max(1, ...game.platforms.map((p) => p.dau));
            const platformAdMax = Math.max(1, ...game.platforms.map((p) => p.ad_show_cnt || 0));
            return (
              <article
                key={game.game_key}
                className="home-game-card"
                style={{ ['--home-heat' as string]: String(heat) }}
              >
                <header className="home-game-card-head">
                  <div className="home-game-card-title-row">
                    <span className="home-game-rank" aria-hidden>
                      {rank}
                    </span>
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
                      aria-label={`${p.label} 日活 ${formatCount(p.dau)}，曝光 ${formatCount(p.ad_show_cnt || 0)}`}
                      onClick={() => openGamePlatform(game.game_key, p.platform)}
                    >
                      <span className="home-platform-label">{p.label}</span>
                      <PlatformMetric kind="dau" value={p.dau} max={platformDauMax} />
                      <PlatformMetric kind="ad" value={p.ad_show_cnt || 0} max={platformAdMax} />
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

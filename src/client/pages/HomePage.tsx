import { Alert, Button, Space, Spin, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { PlatformFilter } from '../../shared/platforms';
import { fetchJson } from '../fetchJson';

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

interface HomeDauResponse {
  ok: boolean;
  date_key?: string;
  computed_at?: number;
  month_from_date?: string;
  month_t1_date?: string;
  month_t1_revenue_cny?: number;
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

  const openGamePlatform = (gameKey: string, platform: PlatformFilter) => {
    navigate(
      `/business/dashboard?game=${encodeURIComponent(gameKey)}&platform=${encodeURIComponent(platform)}&window=today`,
    );
  };

  return (
    <div className="home-page">
      <div className="home-toolbar">
        <div className="home-toolbar-text">
          <Title level={4} className="home-heading">
            今日总览
          </Title>
          <Text type="secondary" className="home-sub">
            {dateKey || '—'} · 日活 / 广告曝光 · 按总日活降序 · 点平台进入看板
          </Text>
        </div>
        <Space>
          <Text type="secondary" className="home-meta">
            {computedAt ? new Date(computedAt).toLocaleTimeString('zh-CN') : '—'}
            <span className="home-meta-sep">·</span>
            每分钟自动刷新
          </Text>
          <Button size="small" onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <div className="home-month-revenue" aria-label="当月截至昨天总收益">
        <div className="home-month-revenue-main">
          <span className="home-month-revenue-label">当月总收益 · T-1</span>
          <span className="home-month-revenue-num mono">{formatYuan(monthT1Revenue)}</span>
          <span className="home-month-revenue-unit">元</span>
        </div>
        <Text type="secondary" className="home-month-revenue-hint">
          {monthFromDate && monthT1Date
            ? `${monthFromDate} ~ ${monthT1Date} · 微信流量主真实收入，不含今日`
            : '微信流量主真实收入，不含今日（今日结算通常未出）'}
        </Text>
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

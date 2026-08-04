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
}

interface HomeGameDau {
  game_key: string;
  display_name: string;
  total_dau: number;
  platforms: HomePlatformDau[];
}

interface HomeDauResponse {
  ok: boolean;
  date_key?: string;
  computed_at?: number;
  games?: HomeGameDau[];
  error?: string;
}

function formatDau(n: number): string {
  if (n >= 10_000) {
    const v = n / 10_000;
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}万`;
  }
  return n.toLocaleString('zh-CN');
}

/**
 * 经分总览主页：紧凑网格展示各游戏今日各平台日活，点击平台进入该游戏看板。
 */
export function HomePage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateKey, setDateKey] = useState('');
  const [computedAt, setComputedAt] = useState<number | null>(null);
  const [games, setGames] = useState<HomeGameDau[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<HomeDauResponse>('/api/realtime/home-dau');
      if (!data.ok) {
        throw new Error(data.error || '加载主页日活失败');
      }
      setDateKey(data.date_key || '');
      setComputedAt(data.computed_at ?? null);
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
            今日日活总览
          </Title>
          <Text type="secondary" className="home-sub">
            {dateKey || '—'} · 按游戏总日活降序 · 点平台进入看板
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

      {error && (
        <Alert type="error" showIcon className="home-alert" message={error} />
      )}

      <Spin spinning={loading && games.length === 0}>
        <div className="home-game-grid">
          {games.map((game, index) => {
            const rank = index + 1;
            const heat = Math.min(1, game.total_dau / maxTotal);
            const platformMax = Math.max(1, ...game.platforms.map((p) => p.dau));
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
                  <div className="home-game-total">
                    <span className="home-game-total-num">{formatDau(game.total_dau)}</span>
                    <span className="home-game-total-label">总日活</span>
                  </div>
                </header>

                <div className="home-platform-list">
                  {game.platforms.map((p) => {
                    const barPct = Math.round((p.dau / platformMax) * 100);
                    return (
                      <button
                        key={p.platform}
                        type="button"
                        className={`home-platform-row home-platform-${p.platform}`}
                        onClick={() => openGamePlatform(game.game_key, p.platform)}
                      >
                        <span className="home-platform-label">{p.label}</span>
                        <span className="home-platform-bar-track" aria-hidden>
                          <span
                            className="home-platform-bar-fill"
                            style={{ width: `${barPct}%` }}
                          />
                        </span>
                        <span className="home-platform-dau mono">{formatDau(p.dau)}</span>
                      </button>
                    );
                  })}
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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { message } from 'antd';

import { getDefaultGameKey, getGameDescriptor } from '../../shared/games';
import {
  parseWindowFromUrl,
  windowToUrlValue,
  type WindowValue,
} from '../timeWindow';

/**
 * 业务分析 Tab 下的全局过滤器上下文。
 *
 * 职责：
 *   - 维护 gameKey / windowSel / refreshToken 三个面板共享状态
 *   - 与 URL 双向同步：state → ?game=&window=（replace，不污染 history）；
 *     URL → state（支持浏览器后退/前进、链接粘贴）
 *   - 提供 5 分钟自动刷新定时器
 *   - 提供 `triggerIngestNow`：手动绕过 cron 拉一次 CloudBase 增量并自动刷新所有面板
 *
 * 不在这里做：
 *   - 具体面板的数据 fetch（每个 Page/Panel 自己拉）。这里只触发 refreshToken++ 即可。
 *
 * 仅在 BusinessLayout 下 mount，OpsLayout 不依赖此 Context（系统运维与游戏/时间窗口无关）。
 */

const AUTO_REFRESH_MS = 5 * 60_000;

interface AnalyticsFilterValue {
  gameKey: string;
  windowSel: WindowValue;
  refreshToken: number;
  /** 当前是否有面板在 fetch（由 Page 通过 setLoading 通知，仅用于 Header 刷新按钮的 loading 态） */
  loading: boolean;
  ingestingNow: boolean;
  /** 最近一次任一面板成功完成 fetch 的时间戳（用于 Header 上的"自动 5 分钟 · xxx"显示） */
  lastRefreshedAt: number;
  setGameKey: (next: string) => void;
  setWindowSel: (next: WindowValue) => void;
  setLoading: (next: boolean) => void;
  setLastRefreshedAt: (ts: number) => void;
  /** 手动刷新：所有依赖 refreshToken 的面板会重新 fetch */
  triggerRefresh: () => void;
  /** 立即从 CloudBase 拉一次（绕过 cron），完成后自动 triggerRefresh */
  triggerIngestNow: () => Promise<void>;
}

const AnalyticsFilterContext = createContext<AnalyticsFilterValue | null>(null);

export function AnalyticsFilterProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();

  // 初始值：URL 优先，其次默认值。
  // 用 lazy initializer 保证只在 mount 时读一次，避免后续 URL 变化触发的重渲染又重新走默认分支
  const [gameKey, setGameKeyState] = useState<string>(() => {
    const fromUrl = searchParams.get('game');
    return fromUrl && getGameDescriptor(fromUrl) ? fromUrl : getDefaultGameKey();
  });
  const [windowSel, setWindowSelState] = useState<WindowValue>(() =>
    parseWindowFromUrl(searchParams.get('window')),
  );
  const [refreshToken, setRefreshToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [ingestingNow, setIngestingNow] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(0);

  // 用 ref 跟踪当前 game/window 的 URL 字符串形式，用于检测"上次写入 URL 的值"，
  // 避免 effect 写入 URL 后被 URL → state 反向监听误以为是用户改了 URL，造成抖动
  const lastSyncedRef = useRef<{ game: string; window: string }>({ game: '', window: '' });

  // state → URL 同步：用 replace 避免每次切游戏/时间窗口都新增一条 history entry
  useEffect(() => {
    const nextGame = gameKey;
    const nextWindow = windowToUrlValue(windowSel);
    if (lastSyncedRef.current.game === nextGame && lastSyncedRef.current.window === nextWindow) {
      return;
    }
    lastSyncedRef.current = { game: nextGame, window: nextWindow };
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('game', nextGame);
        next.set('window', nextWindow);
        return next;
      },
      { replace: true },
    );
  }, [gameKey, windowSel, setSearchParams]);

  // URL → state 同步（浏览器后退/前进、外部粘贴 URL）：
  // 用 functional setState 避免把 gameKey/windowSel 放进依赖造成循环
  useEffect(() => {
    const urlGame = searchParams.get('game');
    const urlWindowRaw = searchParams.get('window');
    const urlWindow = parseWindowFromUrl(urlWindowRaw);
    if (urlGame && getGameDescriptor(urlGame)) {
      setGameKeyState((cur) => (urlGame !== cur ? urlGame : cur));
    }
    setWindowSelState((cur) =>
      windowToUrlValue(urlWindow) !== windowToUrlValue(cur) ? urlWindow : cur,
    );
  }, [searchParams]);

  const setGameKey = useCallback((next: string) => {
    setGameKeyState(next);
  }, []);
  const setWindowSel = useCallback((next: WindowValue) => {
    setWindowSelState(next);
  }, []);
  const triggerRefresh = useCallback(() => {
    setRefreshToken((t) => t + 1);
  }, []);

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
        // 给子组件 fetch 留 ~800ms 视觉窗口，避免按钮 loading 一闪就停但下方面板还在静默加载
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

  // 与后端 cron */5 对齐的自动刷新；首次进入不再立即多触发一次（Page 内 effect 已会 mount 时 fetch）
  useEffect(() => {
    const timer = window.setInterval(() => {
      setRefreshToken((t) => t + 1);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const value = useMemo<AnalyticsFilterValue>(
    () => ({
      gameKey,
      windowSel,
      refreshToken,
      loading,
      ingestingNow,
      lastRefreshedAt,
      setGameKey,
      setWindowSel,
      setLoading,
      setLastRefreshedAt,
      triggerRefresh,
      triggerIngestNow,
    }),
    [
      gameKey,
      windowSel,
      refreshToken,
      loading,
      ingestingNow,
      lastRefreshedAt,
      setGameKey,
      setWindowSel,
      triggerRefresh,
      triggerIngestNow,
    ],
  );

  return (
    <AnalyticsFilterContext.Provider value={value}>{children}</AnalyticsFilterContext.Provider>
  );
}

export function useAnalyticsFilter(): AnalyticsFilterValue {
  const ctx = useContext(AnalyticsFilterContext);
  if (!ctx) {
    throw new Error('useAnalyticsFilter 必须在 <AnalyticsFilterProvider> 内调用');
  }
  return ctx;
}

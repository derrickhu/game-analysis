import { EventsExplorer } from '../EventsExplorer';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';

/**
 * 原始事件页面：薄壳，从全局 filter 读 game/window/refreshToken 透传给 EventsExplorer。
 * EventsExplorer 已设计为受控组件（无内部时间窗口状态），这里不做额外加工。
 */
export function EventsPage() {
  const { gameKey, platform, windowSel, refreshToken } = useAnalyticsFilter();
  return (
    <EventsExplorer fixedGameKey={gameKey} platform={platform} windowSel={windowSel} refreshToken={refreshToken} />
  );
}

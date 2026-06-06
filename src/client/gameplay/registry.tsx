import type { ComponentType } from 'react';
import { Card, Empty } from 'antd';

import type { GameplayPanelId } from '../../shared/games';
import { CaizhuGameplayPanel } from './CaizhuGameplayPanel';
import { EconomyFlowPanel } from './EconomyFlowPanel';
import { EngagementPanel } from './EngagementPanel';
import { GrowthProgressPanel } from './GrowthProgressPanel';
import { HotpotDailyLimitedPanel } from './HotpotDailyLimitedPanel';
import { HotpotFruitSlicePanel } from './HotpotFruitSlicePanel';
import { LevelProgressPanel } from './LevelProgressPanel';
import { OrderFunnelPanel } from './OrderFunnelPanel';

/**
 * 玩法分析面板注册表：GameplayPanelId → 渲染组件 / 中文标题。
 *
 * 添加新的玩法面板：
 *   1. 在 src/shared/games.ts 的 GameplayPanelId 加 ID
 *   2. 在 src/client/gameplay/ 下新建 React 组件（接受全局 filter，自管 fetch）
 *   3. 这里登记 ID → 组件
 *   4. 在 ALL_GAMES[].gameplayPanels 把 ID 加到对应游戏
 *
 * 组件不接受 props，统一从 useAnalyticsFilter() 读 gameKey/windowSel/refreshToken，
 * 与 dashboard 内其它面板保持一致的"受控于全局过滤器"风格。
 */
export interface GameplayPanelMeta {
  id: GameplayPanelId;
  title: string;
  Component: ComponentType;
}

/**
 * 占位组件：玩法 ID 已声明、面板尚未实现时使用。
 * 一旦真正实现该面板，把对应 GAMEPLAY_PANEL_REGISTRY 项的 Component 换成实际组件即可。
 *
 * 默认 ALL_GAMES 中各游戏的 gameplayPanels 不会指向这些占位（保持空数组），
 * 仅当临时性"先占位、后补面板"时才会被渲染。
 */
function PlaceholderPanel(id: string, title: string): ComponentType {
  const Stub = () => (
    <Card title={title}>
      <Empty description={`该面板尚未实现（${id}），先占位等待业务事件接入完成`} />
    </Card>
  );
  Stub.displayName = `PlaceholderPanel(${id})`;
  return Stub;
}

export const GAMEPLAY_PANEL_REGISTRY: Record<GameplayPanelId, GameplayPanelMeta> = {
  level_progress: {
    id: 'level_progress',
    title: '关卡通关漏斗',
    Component: LevelProgressPanel,
  },
  hotpot_fruit_slice: {
    id: 'hotpot_fruit_slice',
    title: '果切挑战分析',
    Component: HotpotFruitSlicePanel,
  },
  hotpot_daily_limited: {
    id: 'hotpot_daily_limited',
    title: '每日限定分析',
    Component: HotpotDailyLimitedPanel,
  },
  huahua_economy_flow: {
    id: 'huahua_economy_flow',
    title: '经济流转健康度',
    Component: EconomyFlowPanel,
  },
  huahua_order_funnel: {
    id: 'huahua_order_funnel',
    title: '订单转化漏斗',
    Component: OrderFunnelPanel,
  },
  huahua_growth: {
    id: 'huahua_growth',
    title: '新手引导 + 首日 cohort',
    Component: GrowthProgressPanel,
  },
  huahua_engagement: {
    id: 'huahua_engagement',
    title: '玩法参与度',
    Component: EngagementPanel,
  },
  caizhu_gameplay: {
    id: 'caizhu_gameplay',
    title: '彩珠玩法总览',
    Component: CaizhuGameplayPanel,
  },
  match_progress: {
    id: 'match_progress',
    title: '消除关卡进度',
    Component: PlaceholderPanel('match_progress', '消除关卡进度'),
  },
};

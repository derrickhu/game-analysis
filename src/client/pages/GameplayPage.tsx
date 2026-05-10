import { Result, Space, Typography } from 'antd';

import { getGameDescriptor } from '../../shared/games';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { GAMEPLAY_PANEL_REGISTRY } from '../gameplay/registry';

const { Text } = Typography;

/**
 * 玩法分析页面：根据当前 gameKey 渲染该游戏专属的玩法 panel 列表。
 *
 * 数据来源：shared/games.ts ALL_GAMES[].gameplayPanels；
 * 多个 panel 时按声明顺序纵向堆叠，每个 panel 自管 fetch（统一受 useAnalyticsFilter 控制）。
 *
 * 三种空态：
 *   1. 游戏未接入 SDK → 显示接入引导（与 DashboardPage 一致体验）
 *   2. 游戏 gameplayPanels 为空 → 显示"该游戏暂无玩法分析模块"，提示后续可加
 *   3. registry 中 ID 不存在（配置错） → 跳过该 ID，避免整页崩溃
 */
export function GameplayPage() {
  const { gameKey } = useAnalyticsFilter();
  const descriptor = getGameDescriptor(gameKey);
  const isIntegrated = descriptor?.hasAnalyticsSdk === true;

  if (!isIntegrated) {
    return (
      <Result
        status="info"
        title={`${descriptor?.displayName ?? gameKey} 暂未接入打点 SDK`}
        subTitle="玩法分析依赖业务事件流，请先接入 @gp/analytics-sdk。"
        extra={
          <Text type="secondary">
            接入完成后翻 <Text code>shared/games.ts</Text> 中 <Text code>hasAnalyticsSdk</Text> 与{' '}
            <Text code>gameplayPanels</Text> 即可。
          </Text>
        }
      />
    );
  }

  const panelIds = descriptor?.gameplayPanels ?? [];
  if (panelIds.length === 0) {
    return (
      <Result
        status="info"
        title={`${descriptor?.displayName ?? gameKey} 暂无玩法分析模块`}
        subTitle="该游戏的业务专属事件还未规划成玩法漏斗（如关卡通关 / 任务签到 / 合成阶段 / 消除进度），暂不展示玩法分析面板。"
        extra={
          <Space orientation="vertical" size="small" align="start">
            <Text>大盘活跃 / 广告 / 分享数据请到「大盘运营」页面查看。</Text>
            <Text type="secondary">
              业务事件接入后，编辑 <Text code>src/shared/games.ts</Text> 给该游戏的{' '}
              <Text code>gameplayPanels</Text> 数组登记面板 ID 即可（已支持 level_progress /
              quest_funnel / merge_economy / match_progress）。
            </Text>
          </Space>
        }
      />
    );
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {panelIds.map((id) => {
        const meta = GAMEPLAY_PANEL_REGISTRY[id];
        if (!meta) {
          // 配置漂移兜底：游戏声明了 registry 中没有的 ID，跳过即可（避免整页崩）
          return null;
        }
        const Comp = meta.Component;
        return <Comp key={id} />;
      })}
    </Space>
  );
}

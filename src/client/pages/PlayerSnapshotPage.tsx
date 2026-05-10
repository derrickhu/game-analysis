import { Result, Space, Typography } from 'antd';

import { getGameDescriptor } from '../../shared/games';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { PlayerSnapshotPanel } from '../gameplay/PlayerSnapshotPanel';

const { Text } = Typography;

/**
 * 玩家档案页面：每日全量快照分析（独立于 5 分钟事件流）。
 *
 * 与「玩法分析」tab 的核心差异：
 *   - 数据频率：每天 04:00 cron 全量拉取一次（手动也可触发）
 *   - 数据视角：玩家"现在是什么状态"（绝对值存量），而不是"做了什么"（窗口内增量）
 *   - 不响应顶部时间窗口选择 —— "今天的快照就是今天的状态"
 *
 * 路由分离的理由：
 *   - 快照与事件流是两条独立 ETL 链路，混在玩法分析 tab 里容易让人误以为它响应窗口选择
 *   - 快照看板的关注重心（教程停留分布 / 经济存量分桶 / 30 天人均趋势）也跟玩法漏斗维度不同
 *
 * 当前接入：huahua（hot-pot 后续按同样模式扩展）。
 */
const SNAPSHOT_SUPPORTED_GAMES = new Set(['huahua']);

export function PlayerSnapshotPage() {
  const { gameKey } = useAnalyticsFilter();
  const descriptor = getGameDescriptor(gameKey);

  if (!SNAPSHOT_SUPPORTED_GAMES.has(gameKey)) {
    return (
      <Result
        status="info"
        title={`${descriptor?.displayName ?? gameKey} 暂未接入玩家档案快照`}
        subTitle="该游戏的玩家档案 DB 拉取链路还未配置；目前只有花花妙屋接入了每日全量快照分析。"
        extra={
          <Space orientation="vertical" size="small" align="start">
            <Text type="secondary">
              接入步骤参见 <Text code>src/server/jobs/ingest-huahua-snapshot.ts</Text> 与{' '}
              <Text code>src/server/snapshot-db.ts</Text>，照同样的模板新建{' '}
              <Text code>{`${gameKey}_player_snapshots`}</Text> 表 + parser + cron 即可。
            </Text>
          </Space>
        }
      />
    );
  }

  // 当前所有受支持游戏共用同一个 panel；后续不同游戏字段差异较大时
  // 可改成类似 GAMEPLAY_PANEL_REGISTRY 的 map 派发
  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <PlayerSnapshotPanel />
    </Space>
  );
}

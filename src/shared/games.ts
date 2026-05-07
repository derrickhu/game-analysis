/**
 * 全部游戏的统一注册表，是 dashboard 选择器、SDK 拉取、存档拉取等模块的共同数据源。
 *
 * 与已有的两个配置的关系：
 * - server/config/analytics-games.ts 的 ANALYTICS_GAMES：SDK 事件流拉取专用（按 hasAnalyticsSdk 翻开关）
 * - shared/game-config.ts 的 GAME_CONFIGS：玩家存档快照拉取（按 hasSnapshotIngest 翻开关，老链路，未来只剩兜底）
 *
 * 所有游戏 gameKey 必须先在这里登记，新增一款游戏只需要：
 *   1. 这里加一行
 *   2. 真正接入了 SDK 就把 hasAnalyticsSdk 翻 true（同时云函数 ANALYTICS_GAME_KEYS 加该 key）
 *   3. 还需要老链路存档差分时把 hasSnapshotIngest 翻 true
 */

export interface GameDescriptor {
  gameKey: string;
  /** 中文显示名，dashboard 选择器用 */
  displayName: string;
  /** 是否已经接入 @gp/analytics-sdk 在产事件流；false 时 dashboard 显示「请先接入 SDK」提示 */
  hasAnalyticsSdk: boolean;
  /** 是否走老的玩家存档快照拉取链路（GAME_CONFIGS）；新游戏一律 false，逐步靠打点 SDK 替代 */
  hasSnapshotIngest: boolean;
}

export const ALL_GAMES: GameDescriptor[] = [
  {
    gameKey: 'hotpot',
    displayName: '别捞水果',
    hasAnalyticsSdk: true,
    // hot-pot 已完成 SDK 标准化打点（含 level_start/clear/fail），存档差分链路下线
    hasSnapshotIngest: false,
  },
  {
    gameKey: 'huahua',
    displayName: '花花妙屋',
    hasAnalyticsSdk: false,
    // 等待接入 SDK 后从打点流水重建数据，先不再拉 player snapshot 避免提供过时口径
    hasSnapshotIngest: false,
  },
  {
    gameKey: 'caizhu',
    displayName: '彩珠五连',
    hasAnalyticsSdk: false,
    hasSnapshotIngest: false,
  },
];

export function getGameDescriptor(gameKey: string): GameDescriptor | undefined {
  return ALL_GAMES.find((g) => g.gameKey === gameKey);
}

export function getDefaultGameKey(): string {
  // 默认选第一个已接入 SDK 的游戏；如果没有，回退到第一个登记的游戏
  return (ALL_GAMES.find((g) => g.hasAnalyticsSdk) ?? ALL_GAMES[0]).gameKey;
}

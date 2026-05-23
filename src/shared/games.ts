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

/**
 * 玩法分析面板枚举（/business/gameplay 页面承载）。
 *
 * 每个 ID 对应一个游戏专属的"产品优化"视图（关卡漏斗 / 任务漏斗 / 经济流转 / 消除进度...），
 * 由 src/client/gameplay/registry.ts 把 ID 映射到具体的 React 组件。
 *
 * 新接入一款游戏时：
 *   1. 这里加新 ID（如果该游戏的玩法语义不在已有枚举里）
 *   2. 在 src/client/gameplay/ 下新建对应 panel 组件
 *   3. registry.ts 里登记 ID → 组件
 *   4. ALL_GAMES[].gameplayPanels 加上该 ID
 */
export type GameplayPanelId =
  | 'level_progress'        // 关卡通关漏斗（hotpot 现役）
  | 'hotpot_fruit_slice'    // 别捞水果：果切挑战玩法分析
  | 'hotpot_daily_limited'  // 别捞水果：每日限定玩法分析
  | 'huahua_economy_flow'   // 花花经济流转健康度（花愿 / 钻石 / 体力的入账出账）
  | 'huahua_order_funnel'   // 花花订单转化漏斗（spawn → deliver / expire / ditch + 按 tier）
  | 'huahua_growth'         // 花花星级成长 + 新手引导漏斗
  | 'huahua_engagement'     // 花花参与度（任务/签到/抽奖/熟客/合成）
  | 'caizhu_gameplay'       // 彩珠五连：入口/经典模式/道具/教程
  | 'match_progress';       // 消除关卡进度（caizhu 待补）

/**
 * 玩家档案快照不属于"玩法分析" —— 它是每日 04:00 全量 DB 快照，
 * 与 5 分钟事件流是两条独立 ETL 链路。所以单独走 /business/player-snapshot 路由，
 * 由 PlayerSnapshotPage 直接挂载对应游戏的 panel，不再通过 GameplayPanelId 注册。
 */

export interface GameDescriptor {
  gameKey: string;
  /** 中文显示名，dashboard 选择器用 */
  displayName: string;
  /** 是否已经接入 @gp/analytics-sdk 在产事件流；false 时 dashboard 显示「请先接入 SDK」提示 */
  hasAnalyticsSdk: boolean;
  /** 是否走老的玩家存档快照拉取链路（GAME_CONFIGS）；新游戏一律 false，逐步靠打点 SDK 替代 */
  hasSnapshotIngest: boolean;
  /**
   * 玩法分析面板列表。
   * 空数组（或未声明）= /business/gameplay 显示「该游戏暂无玩法分析模块」引导。
   * 多个 ID 时按声明顺序在页面纵向堆叠（一般每款游戏 1~3 个面板足够）。
   */
  gameplayPanels?: GameplayPanelId[];
  /** 通用商业化指标配置。LTV/ARPU/ARPDAU 等平台级指标只看这里，不写游戏专属逻辑。 */
  monetization?: {
    /** 是否接入广告变现；当前 LTV 的收入来源主要是 ad_show × eCPM 估算。 */
    ads: boolean;
    /** 是否接入内购；预留给 purchase_complete，当前游戏都先为 false。 */
    iap: boolean;
    /** eCPM 配置 profile；默认等于 gameKey，后续同一游戏多版本口径可在这里分流。 */
    ecpmProfile?: string;
  };
}

export const ALL_GAMES: GameDescriptor[] = [
  {
    gameKey: 'hotpot',
    displayName: '别捞水果',
    hasAnalyticsSdk: true,
    // hot-pot 已完成 SDK 标准化打点（含 level_start/clear/fail），存档差分链路下线
    hasSnapshotIngest: false,
    gameplayPanels: ['level_progress', 'hotpot_fruit_slice', 'hotpot_daily_limited'],
    monetization: { ads: true, iap: false, ecpmProfile: 'hotpot' },
  },
  {
    gameKey: 'huahua',
    displayName: '花花妙屋',
    hasAnalyticsSdk: true,
    // 2026-05-10 接入 @gp/analytics-sdk 通用层（session/login/ad/share/tutorial/app_error）。
    // 2026-05-10 补全 17 个业务专属事件（merge/order/decoration/dressup/star/quest/checkin/fountain/affinity/...），
    // 玩法分析 4 个面板（经济流转 / 订单漏斗 / 成长 / 参与度）配套上线。
    hasSnapshotIngest: false,
    gameplayPanels: [
      'huahua_economy_flow',
      'huahua_order_funnel',
      'huahua_growth',
      'huahua_engagement',
    ],
    monetization: { ads: true, iap: false, ecpmProfile: 'huahua' },
  },
  {
    gameKey: 'caizhu',
    displayName: '彩珠五连',
    hasAnalyticsSdk: true,
    hasSnapshotIngest: false,
    gameplayPanels: ['level_progress', 'caizhu_gameplay'],
    monetization: { ads: true, iap: false, ecpmProfile: 'caizhu' },
  },
];

export function getGameDescriptor(gameKey: string): GameDescriptor | undefined {
  return ALL_GAMES.find((g) => g.gameKey === gameKey);
}

export function getDefaultGameKey(): string {
  // 默认选第一个已接入 SDK 的游戏；如果没有，回退到第一个登记的游戏
  return (ALL_GAMES.find((g) => g.hasAnalyticsSdk) ?? ALL_GAMES[0]).gameKey;
}

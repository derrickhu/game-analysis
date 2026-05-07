import type { DashboardModuleConfig, MetricCatalogItem } from './types';

export interface GameConfig {
  gameKey: string;
  displayName: string;
  payloadPrefix: string;
  collectionName: string;
  cloudEnv: string;
  ingestCron: string;
  commonMetricKeys: string[];
  dashboardModules: DashboardModuleConfig[];
  playerColumns: string[];
}

export const METRIC_CATALOG: MetricCatalogItem[] = [
  {
    key: 'users_total',
    name: '玩家总量',
    description: '本地最新玩家快照中的去重玩家数。',
    unit: '人',
    source: 'snapshot',
    precision: 'exact',
    common: true,
  },
  {
    key: 'snapshot_inferred_active',
    name: '快照推导活跃',
    description: '定时拉取中玩家快照版本发生变化的去重玩家数，不等同于启动 DAU。',
    unit: '人',
    source: 'snapshot_inferred',
    precision: 'inferred',
    common: true,
  },
  {
    key: 'avg_level',
    name: '平均等级',
    description: '最新玩家事实表中的等级均值。',
    unit: '级',
    source: 'snapshot',
    precision: 'exact',
    common: true,
  },
  {
    key: 'avg_diamond',
    name: '平均钻石',
    description: '最新玩家事实表中的钻石余额均值。',
    unit: '个',
    source: 'snapshot',
    precision: 'exact',
    common: true,
  },
  {
    key: 'total_merges',
    name: '累计合成',
    description: '来自花花妙屋 huahua_merge_stats.totalMerges。',
    unit: '次',
    source: 'snapshot',
    precision: 'exact',
    common: false,
  },
  {
    key: 'total_orders',
    name: '累计订单',
    description: '来自花花妙屋 huahua_merge_stats.totalOrders，表示累计交付订单数。',
    unit: '单',
    source: 'snapshot',
    precision: 'exact',
    common: false,
  },
  {
    key: 'ad_entitlement_used',
    name: '广告权益使用',
    description: '来自 huahua_ad_entitlements.used 或 dailyUsed 的权益消耗求和，不等于广告展示或完成次数。',
    unit: '次',
    source: 'snapshot',
    precision: 'inferred',
    common: false,
  },
  {
    key: 'real_dau',
    name: '真实 DAU',
    description: '需要 session_start 或 login 事件后才能准确计算。',
    unit: '人',
    source: 'event',
    precision: 'planned',
    common: true,
  },
  {
    key: 'hotpot_max_level',
    name: '最高关卡',
    description: '来自 hotpot_bowl_progress.maxUnlockedLevelIndex，表示玩家最高解锁关卡。',
    unit: '关',
    source: 'snapshot',
    precision: 'exact',
    common: false,
  },
  {
    key: 'hotpot_badge_level',
    name: '徽章进度',
    description: '来自 hotpot_bowl_progress.maxUnlockedBadgeLevelNumber，表示徽章解锁进度。',
    unit: '关',
    source: 'snapshot',
    precision: 'exact',
    common: false,
  },
];

/**
 * GAME_CONFIGS：玩家存档快照（player snapshot）拉取链路用的配置，是【已下线的老链路】。
 * - 全部游戏均已迁移到 @gp/analytics-sdk 标准化打点，dashboard 完全由 analytics_events 驱动
 * - 该数组现已为空。保留 type / METRIC_CATALOG 供后端老路由（/api/dashboard 等）兜底返回
 *   空响应时不会编译报错；scheduler 看到空数组会自然跳过老 cron
 * - 如需重新启用某个游戏的存档快照差分，只需把它加回数组并保证表 schema 仍然存在；
 *   但更推荐沿用 SDK 链路，避免维护两套并存数据通道
 */
export const GAME_CONFIGS: GameConfig[] = [];

export function getGameConfig(gameKey: string): GameConfig | undefined {
  return GAME_CONFIGS.find((item) => item.gameKey === gameKey);
}

export function getMetricCatalog(keys?: string[]): MetricCatalogItem[] {
  if (!keys) return METRIC_CATALOG;
  const keySet = new Set(keys);
  return METRIC_CATALOG.filter((item) => keySet.has(item.key));
}

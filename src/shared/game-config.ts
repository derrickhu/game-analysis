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

const COMMON_MODULES: DashboardModuleConfig[] = [
  {
    key: 'common-overview',
    title: '经营概览',
    kind: 'overview',
    metricKeys: ['users_total', 'snapshot_inferred_active', 'avg_level', 'avg_diamond'],
    description: '跨游戏复用的核心经营概览。',
  },
  {
    key: 'common-activity',
    title: '活跃趋势',
    kind: 'activity',
    metricKeys: ['snapshot_inferred_active', 'real_dau'],
    description: '当前使用快照变化推导活跃，真实 DAU 等事件接入。',
  },
];

export const GAME_CONFIGS: GameConfig[] = [
  {
    gameKey: 'huahua',
    displayName: '花花妙屋',
    payloadPrefix: 'huahua',
    collectionName: 'huahua_playerData',
    cloudEnv: 'rosa-env-d7grf78r5dbd37323',
    ingestCron: '0 * * * *',
    commonMetricKeys: ['users_total', 'snapshot_inferred_active', 'avg_level', 'avg_diamond'],
    dashboardModules: [
      ...COMMON_MODULES,
      {
        key: 'huahua-merge',
        title: '合成经营',
        kind: 'merge',
        metricKeys: ['total_merges'],
        description: '合成次数、今日合成和合成增长。',
      },
      {
        key: 'huahua-orders',
        title: '订单经营',
        kind: 'orders',
        metricKeys: ['total_orders'],
        description: '订单交付、订单玩家占比和订单增长。',
      },
      {
        key: 'huahua-checkin-quest',
        title: '签到任务',
        kind: 'checkinQuest',
        metricKeys: [],
        description: '签到、连续签到、每日任务和周积分。',
      },
      {
        key: 'huahua-events-collection',
        title: '活动收集',
        kind: 'eventsCollection',
        metricKeys: [],
        description: '活动积分、活动进度和收集装扮深度。',
      },
      {
        key: 'huahua-ad',
        title: '广告权益',
        kind: 'adEntitlement',
        metricKeys: ['ad_entitlement_used'],
        description: '广告权益消耗统计，不等于广告完成。',
      },
    ],
    playerColumns: [
      'userId',
      'platform',
      'activeDate',
      'level',
      'diamond',
      'mergeCountTotal',
      'deliveredOrdersTotal',
      'adEntitlementUsedToday',
      'checkinTotalDays',
      'questWeeklyPoints',
    ],
  },
  {
    gameKey: 'hotpot',
    displayName: '别捞水果',
    payloadPrefix: 'hotpot',
    collectionName: 'hotpot_playerData',
    cloudEnv: 'rosa-env-d7grf78r5dbd37323',
    ingestCron: '0 * * * *',
    commonMetricKeys: ['users_total', 'snapshot_inferred_active', 'avg_level'],
    dashboardModules: [
      {
        key: 'hotpot-overview',
        title: '经营概览',
        kind: 'overview',
        metricKeys: ['users_total', 'snapshot_inferred_active', 'avg_level'],
        description: 'hot-pot 当前基于云存档快照展示玩家规模与关卡进度。',
      },
      {
        key: 'hotpot-activity',
        title: '活跃趋势',
        kind: 'activity',
        metricKeys: ['snapshot_inferred_active', 'real_dau'],
        description: '当前使用快照变化推导活跃，真实 DAU 等事件接入。',
      },
      {
        key: 'hotpot-progress',
        title: '关卡进度',
        kind: 'hotpotProgress',
        metricKeys: ['hotpot_max_level', 'hotpot_badge_level'],
        description: '基于 hotpot_bowl_progress 的当前关卡、最高解锁关卡和徽章进度。',
      },
    ],
    playerColumns: [
      'userId',
      'platform',
      'activeDate',
      'level',
      'star',
    ],
  },
];

export function getGameConfig(gameKey: string): GameConfig {
  return GAME_CONFIGS.find((item) => item.gameKey === gameKey) ?? GAME_CONFIGS[0];
}

export function getMetricCatalog(keys?: string[]): MetricCatalogItem[] {
  if (!keys) return METRIC_CATALOG;
  const keySet = new Set(keys);
  return METRIC_CATALOG.filter((item) => keySet.has(item.key));
}

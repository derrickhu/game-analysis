export type GameKey = 'huahua' | string;

export interface RawSnapshot {
  id?: number;
  gameKey: GameKey;
  collectionName: string;
  docId: string;
  userId: string;
  platform: string;
  schemaVersion: number;
  updatedAt: number;
  lastWriteAt: number;
  payloadKeys: string[];
  payload: Record<string, string>;
  importedAt: number;
}

export interface PlayerFacts {
  gameKey: GameKey;
  userId: string;
  platform: string;
  snapshotUpdatedAt: number;
  lastWriteAt: number;
  level: number;
  star: number;
  flowerWish: number;
  diamond: number;
  energy: number;
  mergeCountTotal: number;
  mergeCountToday: number;
  deliveredOrdersTotal: number;
  checkinTotalDays: number;
  checkinStreakDays: number;
  questWeeklyPoints: number;
  eventPoints: number;
  adEntitlementUsedToday: number;
  tutorialStep: string;
  activeDate: string;
  raw: Record<string, unknown>;
}

export type MetricSource = 'snapshot' | 'snapshot_inferred' | 'event' | 'manual';
export type MetricPrecision = 'exact' | 'inferred' | 'planned';
export type DashboardModuleKind =
  | 'overview'
  | 'activity'
  | 'progress'
  | 'economy'
  | 'commerce'
  | 'merge'
  | 'orders'
  | 'checkinQuest'
  | 'eventsCollection'
  | 'adEntitlement'
  | 'quality';

export interface MetricCatalogItem {
  key: string;
  name: string;
  description: string;
  unit: string;
  source: MetricSource;
  precision: MetricPrecision;
  common: boolean;
}

export interface DashboardModuleConfig {
  key: string;
  title: string;
  kind: DashboardModuleKind;
  metricKeys: string[];
  description: string;
}

export interface DailyMetric {
  gameKey: GameKey;
  metricDate: string;
  usersTotal: number;
  activeUsers: number;
  avgLevel: number;
  p50Level: number;
  avgDiamond: number;
  avgEnergy: number;
  totalMergeCount: number;
  totalDeliveredOrders: number;
  totalAdEntitlementUsed: number;
  updatedAt: number;
}

export interface HourlyMetric {
  gameKey: GameKey;
  metricHour: string;
  inferredActiveUsers: number;
  changedSnapshots: number;
  newUsers: number;
  firstOrderUsers: number;
  orderDelta: number;
  mergeDelta: number;
  /** 快照对比得到的广告权益当日已用量增量（见 huahua_ad_entitlements，非全量广告请求次数） */
  adEntitlementDelta: number;
  updatedAt: number;
}

export interface DashboardSummary {
  latestDate: string;
  latestHour: string;
  usersTotal: number;
  activeUsers: number;
  inferredActiveUsersToday: number;
  /** 当前时间往前 60 分钟内 last_write_at 落在区间内的去重玩家（存档写入近似，非并发在线） */
  lastWriteWithinHourUsers: number;
  /** 次日留存率：目标日前 1 天首日活跃 cohort，在目标日再次活跃的占比 */
  retentionD1Rate: number | null;
  retentionD1CohortUsers: number;
  retentionD1ReturnedUsers: number;
  /** 7 日留存率：目标日前 7 天首日活跃 cohort，在目标日再次活跃的占比 */
  retentionD7Rate: number | null;
  retentionD7CohortUsers: number;
  retentionD7ReturnedUsers: number;
  avgLevel: number;
  avgDiamond: number;
  totalMergeCount: number;
  totalDeliveredOrders: number;
}

export interface LevelBucket {
  level: number;
  users: number;
}

export interface QualitySummary {
  storageMode: string;
  lastIngestAt: number;
  nextIngestAt: number;
  latestRun?: IngestRun;
  snapshotCount: number;
  historyCount: number;
  changedSnapshotCount: number;
  parseFailedCount: number;
}

export interface IngestRun {
  id: number;
  gameKey: GameKey;
  collectionName: string;
  status: 'running' | 'success' | 'failed';
  startedAt: number;
  finishedAt: number;
  fetchedCount: number;
  changedCount: number;
  unchangedCount: number;
  errorMessage: string;
}

export interface HuahuaSpecificMetrics {
  totalOrders: number;
  todayOrders: number;
  playersWithOrders: number;
  totalMerges: number;
  todayMerges: number;
  totalCheckinDays: number;
  totalQuestWeeklyPoints: number;
  totalEventPoints: number;
  totalAdEntitlementUsed: number;
}

export interface DashboardData {
  summary: DashboardSummary;
  dailyMetrics: DailyMetric[];
  hourlyMetrics: HourlyMetric[];
  levelBuckets: LevelBucket[];
  recentPlayers: PlayerFacts[];
  metricCatalog: MetricCatalogItem[];
  modules: DashboardModuleConfig[];
  quality: QualitySummary;
  gameSpecific: {
    huahua?: HuahuaSpecificMetrics;
  };
}

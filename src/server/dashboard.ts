import type { DashboardData, DashboardSummary, HourlyMetric, HotpotSpecificMetrics, HuahuaSpecificMetrics } from '../shared/types';
import { getGameConfig, getMetricCatalog } from '../shared/game-config';
import { getConfig } from './config';
import {
  countRecentWrites,
  getQualityCounts,
  getSummaryFacts,
  listDailyMetrics,
  listHourlyMetrics,
  listIngestRuns,
  listLevelBuckets,
  listPlayerFacts,
  listSnapshotHistoryRows,
} from './db';
import { toShanghaiDateKey } from './time';

interface RetentionResult {
  rate: number | null;
  cohortUsers: number;
  returnedUsers: number;
}

function addDays(dateKey: string, offsetDays: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return date.toISOString().slice(0, 10);
}

function shanghaiHourKeyToUtcMs(hourKey: string): number {
  const [datePart, hourPart] = hourKey.split('T');
  if (!datePart || !hourPart) return 0;
  const [year, month, day] = datePart.split('-').map(Number);
  const hour = Number(hourPart);
  return Date.UTC(year, month - 1, day, hour - 8);
}

function utcMsToShanghaiHourKey(timestamp: number): string {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 13);
}

function fillHourlyGaps(gameKey: string, metrics: HourlyMetric[]): HourlyMetric[] {
  if (metrics.length <= 1) return metrics;

  const byHour = new Map(metrics.map((metric) => [metric.metricHour, metric]));
  const start = shanghaiHourKeyToUtcMs(metrics[0]!.metricHour);
  const end = shanghaiHourKeyToUtcMs(metrics.at(-1)!.metricHour);
  if (!start || !end || end < start) return metrics;

  const filled: HourlyMetric[] = [];
  for (let ts = start; ts <= end; ts += 60 * 60 * 1000) {
    const metricHour = utcMsToShanghaiHourKey(ts);
    filled.push(byHour.get(metricHour) ?? {
      gameKey,
      metricHour,
      inferredActiveUsers: 0,
      changedSnapshots: 0,
      newUsers: 0,
      firstOrderUsers: 0,
      orderDelta: 0,
      mergeDelta: 0,
      adEntitlementDelta: 0,
      levelDelta: 0,
      badgeDelta: 0,
      updatedAt: Date.now(),
    });
  }
  return filled;
}

async function calculateRetention(gameKey: string, targetDate: string, dayOffset: number): Promise<RetentionResult> {
  if (!targetDate) return { rate: null, cohortUsers: 0, returnedUsers: 0 };

  const cohortDate = addDays(targetDate, -dayOffset);
  const rows = (await listSnapshotHistoryRows(gameKey))
    .filter((row) => Number(row.last_write_at) > 0)
    .sort((a, b) => Number(a.last_write_at) - Number(b.last_write_at)) as Array<{ user_id: string; last_write_at: number }>;

  const firstActiveDateByUser = new Map<string, string>();
  const activeDatesByUser = new Map<string, Set<string>>();
  for (const row of rows) {
    const activeDate = toShanghaiDateKey(Number(row.last_write_at));
    const dates = activeDatesByUser.get(row.user_id) ?? new Set<string>();
    dates.add(activeDate);
    activeDatesByUser.set(row.user_id, dates);
    if (!firstActiveDateByUser.has(row.user_id)) {
      firstActiveDateByUser.set(row.user_id, activeDate);
    }
  }

  const cohortUsers = [...firstActiveDateByUser.entries()]
    .filter(([, firstActiveDate]) => firstActiveDate === cohortDate)
    .map(([userId]) => userId);
  const returnedUsers = cohortUsers.filter((userId) => activeDatesByUser.get(userId)?.has(targetDate)).length;

  return {
    rate: cohortUsers.length > 0 ? returnedUsers / cohortUsers.length : null,
    cohortUsers: cohortUsers.length,
    returnedUsers,
  };
}

export async function getDashboardData(gameKey: string): Promise<DashboardData> {
  const gameConfig = getGameConfig(gameKey);
  const metricKeys = [
    ...gameConfig.commonMetricKeys,
    ...gameConfig.dashboardModules.flatMap((module) => module.metricKeys),
  ];
  const dailyMetrics = await listDailyMetrics(gameKey);
  const latestMetric = dailyMetrics.at(-1);
  const rawHourlyMetrics = await listHourlyMetrics(gameKey);
  const latestHourlyMetric = rawHourlyMetrics.at(-1);
  const hourlyMetrics = fillHourlyGaps(gameKey, rawHourlyMetrics);
  const summaryRow = await getSummaryFacts(gameKey);

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const writeWindowUsers = await countRecentWrites(gameKey, oneHourAgo);
  const retentionD1 = await calculateRetention(gameKey, latestMetric?.metricDate || '', 1);
  const retentionD7 = await calculateRetention(gameKey, latestMetric?.metricDate || '', 7);

  const summary: DashboardSummary = {
    latestDate: latestMetric?.metricDate || '',
    latestHour: latestHourlyMetric?.metricHour || '',
    usersTotal: Number(summaryRow?.usersTotal || 0),
    activeUsers: latestMetric?.activeUsers || 0,
    inferredActiveUsersToday: latestMetric?.activeUsers || 0,
    lastWriteWithinHourUsers: writeWindowUsers,
    retentionD1Rate: retentionD1.rate,
    retentionD1CohortUsers: retentionD1.cohortUsers,
    retentionD1ReturnedUsers: retentionD1.returnedUsers,
    retentionD7Rate: retentionD7.rate,
    retentionD7CohortUsers: retentionD7.cohortUsers,
    retentionD7ReturnedUsers: retentionD7.returnedUsers,
    avgLevel: Number(summaryRow?.avgLevel || 0),
    avgDiamond: Number(summaryRow?.avgDiamond || 0),
    totalMergeCount: Number(summaryRow?.totalMergeCount || 0),
    totalDeliveredOrders: Number(summaryRow?.totalDeliveredOrders || 0),
  };

  const levelBuckets = await listLevelBuckets(gameKey);
  const recentPlayers = await listPlayerFacts(gameKey);

  const huahua: HuahuaSpecificMetrics = {
    totalOrders: recentPlayers.reduce((sum, item) => sum + item.deliveredOrdersTotal, 0),
    todayOrders: recentPlayers.reduce((sum, item) => sum + Number((item.raw.mergeStats as any)?.todayOrders || 0), 0),
    playersWithOrders: recentPlayers.filter((item) => item.deliveredOrdersTotal > 0).length,
    totalMerges: recentPlayers.reduce((sum, item) => sum + item.mergeCountTotal, 0),
    todayMerges: recentPlayers.reduce((sum, item) => sum + item.mergeCountToday, 0),
    totalCheckinDays: recentPlayers.reduce((sum, item) => sum + item.checkinTotalDays, 0),
    totalQuestWeeklyPoints: recentPlayers.reduce((sum, item) => sum + item.questWeeklyPoints, 0),
    totalEventPoints: recentPlayers.reduce((sum, item) => sum + item.eventPoints, 0),
    totalAdEntitlementUsed: recentPlayers.reduce((sum, item) => sum + item.adEntitlementUsedToday, 0),
  };
  const hotpot: HotpotSpecificMetrics = {
    currentLevelAvg: recentPlayers.length > 0
      ? recentPlayers.reduce((sum, item) => sum + Number((item.raw.progress as any)?.currentLevel || item.level), 0) / recentPlayers.length
      : 0,
    maxUnlockedLevelAvg: recentPlayers.length > 0
      ? recentPlayers.reduce((sum, item) => sum + item.level, 0) / recentPlayers.length
      : 0,
    maxUnlockedLevel: recentPlayers.reduce((max, item) => Math.max(max, item.level), 0),
    maxUnlockedBadgeLevel: recentPlayers.reduce((max, item) => Math.max(max, item.star), 0),
    playersStarted: recentPlayers.filter((item) => item.level > 1 || item.star > 0).length,
    musicEnabledUsers: recentPlayers.filter((item) => (item.raw.settings as any)?.musicEnabled !== false).length,
    soundEnabledUsers: recentPlayers.filter((item) => (item.raw.settings as any)?.soundEnabled !== false).length,
  };

  const runs = await listIngestRuns(gameKey, 1);
  const latestRun = runs[0];
  const qualityCounts = await getQualityCounts(gameKey);

  return {
    summary,
    dailyMetrics,
    hourlyMetrics,
    levelBuckets,
    recentPlayers,
    metricCatalog: getMetricCatalog([...new Set(metricKeys)]),
    modules: gameConfig.dashboardModules,
    quality: {
      storageMode: getConfig().storageMode,
      lastIngestAt: latestRun?.finishedAt || 0,
      nextIngestAt: 0,
      latestRun,
      ...qualityCounts,
    },
    gameSpecific: {
      huahua: gameKey === 'huahua' ? huahua : undefined,
      hotpot: gameKey === 'hotpot' ? hotpot : undefined,
    },
  };
}

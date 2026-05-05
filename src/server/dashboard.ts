import type { DashboardData, DashboardSummary, DailyMetric, HuahuaSpecificMetrics, LevelBucket, PlayerFacts } from '../shared/types';
import { getGameConfig, getMetricCatalog } from '../shared/game-config';
import { getConfig } from './config';
import { getDb, getQualityCounts, listHourlyMetrics, listIngestRuns } from './db';
import { toShanghaiDateKey } from './time';

interface RetentionResult {
  rate: number | null;
  cohortUsers: number;
  returnedUsers: number;
}

function mapMetric(row: any): DailyMetric {
  return {
    gameKey: row.game_key,
    metricDate: row.metric_date,
    usersTotal: row.users_total,
    activeUsers: row.active_users,
    avgLevel: row.avg_level,
    p50Level: row.p50_level,
    avgDiamond: row.avg_diamond,
    avgEnergy: row.avg_energy,
    totalMergeCount: row.total_merge_count,
    totalDeliveredOrders: row.total_delivered_orders,
    totalAdEntitlementUsed: row.total_ad_entitlement_used,
    updatedAt: row.updated_at,
  };
}

function mapPlayer(row: any): PlayerFacts {
  return {
    gameKey: row.game_key,
    userId: row.user_id,
    platform: row.platform,
    snapshotUpdatedAt: row.snapshot_updated_at,
    lastWriteAt: row.last_write_at,
    level: row.level,
    star: row.star,
    flowerWish: row.flower_wish,
    diamond: row.diamond,
    energy: row.energy,
    mergeCountTotal: row.merge_count_total,
    mergeCountToday: row.merge_count_today,
    deliveredOrdersTotal: row.delivered_orders_total,
    checkinTotalDays: row.checkin_total_days,
    checkinStreakDays: row.checkin_streak_days,
    questWeeklyPoints: row.quest_weekly_points,
    eventPoints: row.event_points,
    adEntitlementUsedToday: row.ad_entitlement_used_today,
    tutorialStep: row.tutorial_step,
    activeDate: row.active_date,
    raw: JSON.parse(row.raw_json || '{}'),
  };
}

function addDays(dateKey: string, offsetDays: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return date.toISOString().slice(0, 10);
}

function calculateRetention(database: ReturnType<typeof getDb>, gameKey: string, targetDate: string, dayOffset: number): RetentionResult {
  if (!targetDate) return { rate: null, cohortUsers: 0, returnedUsers: 0 };

  const cohortDate = addDays(targetDate, -dayOffset);
  const rows = database.prepare(`
    SELECT user_id, last_write_at
    FROM raw_snapshot_history
    WHERE game_key = ? AND last_write_at > 0
    ORDER BY last_write_at ASC
  `).all(gameKey) as Array<{ user_id: string; last_write_at: number }>;

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

export function getDashboardData(gameKey: string): DashboardData {
  const gameConfig = getGameConfig(gameKey);
  const database = getDb();
  const dailyMetrics = (database.prepare(`
    SELECT * FROM daily_metrics
    WHERE game_key = ?
    ORDER BY metric_date ASC
  `).all(gameKey) as any[]).map(mapMetric);

  const latestMetric = dailyMetrics.at(-1);
  const hourlyMetrics = listHourlyMetrics(gameKey);
  const latestHourlyMetric = hourlyMetrics.at(-1);
  const summaryRow = database.prepare(`
    SELECT
      COUNT(*) AS usersTotal,
      AVG(level) AS avgLevel,
      AVG(diamond) AS avgDiamond,
      SUM(merge_count_total) AS totalMergeCount,
      SUM(delivered_orders_total) AS totalDeliveredOrders
    FROM player_facts
    WHERE game_key = ?
  `).get(gameKey) as any;

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const writeWindowRow = database.prepare(`
    SELECT COUNT(*) AS c
    FROM player_facts
    WHERE game_key = ? AND last_write_at >= ?
  `).get(gameKey, oneHourAgo) as any;
  const retentionD1 = calculateRetention(database, gameKey, latestMetric?.metricDate || '', 1);
  const retentionD7 = calculateRetention(database, gameKey, latestMetric?.metricDate || '', 7);

  const summary: DashboardSummary = {
    latestDate: latestMetric?.metricDate || '',
    latestHour: latestHourlyMetric?.metricHour || '',
    usersTotal: Number(summaryRow?.usersTotal || 0),
    activeUsers: latestMetric?.activeUsers || 0,
    inferredActiveUsersToday: latestMetric?.activeUsers || 0,
    lastWriteWithinHourUsers: Number(writeWindowRow?.c || 0),
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

  const levelBuckets = database.prepare(`
    SELECT level, COUNT(*) AS users
    FROM player_facts
    WHERE game_key = ?
    GROUP BY level
    ORDER BY level ASC
  `).all(gameKey) as LevelBucket[];

  const recentPlayers = (database.prepare(`
    SELECT * FROM player_facts
    WHERE game_key = ?
    ORDER BY last_write_at DESC
  `).all(gameKey) as any[]).map(mapPlayer);

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

  const runs = listIngestRuns(gameKey, 1);
  const latestRun = runs[0];
  const qualityCounts = getQualityCounts(gameKey);

  return {
    summary,
    dailyMetrics,
    hourlyMetrics,
    levelBuckets,
    recentPlayers,
    metricCatalog: getMetricCatalog(),
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
    },
  };
}

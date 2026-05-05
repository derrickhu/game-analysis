import type { DailyMetric, PlayerFacts, RawSnapshot } from '../shared/types';
import type { HourlyMetric } from '../shared/types';
import {
  getDb,
  listRawSnapshots,
  listSnapshotHistoryRows,
  replaceDailyMetrics,
  replaceHourlyMetrics,
  upsertPlayerFacts,
} from './db';
import { parseHuahuaSnapshot } from './adapters/huahua';
import { toShanghaiHourKey } from './time';

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
  return sorted[index];
}

/** 今日权益已用量在相邻快照间的增量；跨自然日时今日字段会重置，仅按新日累计近似 */
function adEntitlementUsedDelta(previous: PlayerFacts | undefined, current: PlayerFacts): number {
  if (!previous) return 0;
  if (previous.activeDate !== current.activeDate) {
    return Math.max(0, current.adEntitlementUsedToday);
  }
  return Math.max(0, current.adEntitlementUsedToday - previous.adEntitlementUsedToday);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function parseSnapshots(gameKey: string): PlayerFacts[] {
  const parser = gameKey === 'huahua' ? parseHuahuaSnapshot : parseHuahuaSnapshot;
  const facts = listRawSnapshots(gameKey).map(parser);

  const database = getDb();
  database.transaction(() => {
    for (const item of facts) upsertPlayerFacts(item);
  })();

  return facts;
}

export function recomputeDailyMetrics(gameKey: string): DailyMetric[] {
  const facts = parseSnapshots(gameKey);
  const byDate = new Map<string, PlayerFacts[]>();

  for (const item of facts) {
    const bucket = byDate.get(item.activeDate) ?? [];
    bucket.push(item);
    byDate.set(item.activeDate, bucket);
  }

  const allUsers = facts.length;
  const metrics: DailyMetric[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([metricDate, players]) => ({
      gameKey,
      metricDate,
      usersTotal: allUsers,
      activeUsers: players.length,
      avgLevel: average(players.map((item) => item.level)),
      p50Level: percentile(players.map((item) => item.level), 0.5),
      avgDiamond: average(players.map((item) => item.diamond)),
      avgEnergy: average(players.map((item) => item.energy)),
      totalMergeCount: sum(players.map((item) => item.mergeCountToday || item.mergeCountTotal)),
      totalDeliveredOrders: sum(players.map((item) => item.deliveredOrdersTotal)),
      totalAdEntitlementUsed: sum(players.map((item) => item.adEntitlementUsedToday)),
      updatedAt: Date.now(),
    }));

  replaceDailyMetrics(gameKey, metrics);
  return metrics;
}

export function recomputeHourlyMetrics(gameKey: string): HourlyMetric[] {
  const rows = listSnapshotHistoryRows(gameKey);
  const parser = gameKey === 'huahua' ? parseHuahuaSnapshot : parseHuahuaSnapshot;
  const byHour = new Map<string, {
    users: Set<string>;
    changed: number;
    newUsers: number;
    firstOrderUsers: number;
    orderDelta: number;
    mergeDelta: number;
    adEntitlementDelta: number;
  }>();
  const previousByUser = new Map<string, PlayerFacts>();

  for (const row of rows) {
    const hour = toShanghaiHourKey(Number(row.changed_at));
    const bucket = byHour.get(hour) ?? {
      users: new Set<string>(),
      changed: 0,
      newUsers: 0,
      firstOrderUsers: 0,
      orderDelta: 0,
      mergeDelta: 0,
      adEntitlementDelta: 0,
    };
    const snapshot: RawSnapshot = {
      gameKey: row.game_key,
      collectionName: row.collection_name,
      docId: row.doc_id,
      userId: row.user_id,
      platform: row.platform,
      schemaVersion: 0,
      updatedAt: Number(row.updated_at || 0),
      lastWriteAt: Number(row.last_write_at || 0),
      payloadKeys: [],
      payload: JSON.parse(row.payload_json || '{}'),
      importedAt: Number(row.changed_at || 0),
    };
    const current = parser(snapshot);
    const previous = previousByUser.get(current.userId);

    bucket.users.add(current.userId);
    bucket.changed++;
    if (!previous) {
      bucket.newUsers++;
    } else {
      const orderDelta = Math.max(0, current.deliveredOrdersTotal - previous.deliveredOrdersTotal);
      const mergeDelta = Math.max(0, current.mergeCountTotal - previous.mergeCountTotal);
      bucket.orderDelta += orderDelta;
      bucket.mergeDelta += mergeDelta;
      bucket.adEntitlementDelta += adEntitlementUsedDelta(previous, current);
      if (previous.deliveredOrdersTotal === 0 && current.deliveredOrdersTotal > 0) {
        bucket.firstOrderUsers++;
      }
    }

    previousByUser.set(current.userId, current);
    byHour.set(hour, bucket);
  }

  const metrics: HourlyMetric[] = [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([metricHour, bucket]) => ({
      gameKey,
      metricHour,
      inferredActiveUsers: bucket.users.size,
      changedSnapshots: bucket.changed,
      newUsers: bucket.newUsers,
      firstOrderUsers: bucket.firstOrderUsers,
      orderDelta: bucket.orderDelta,
      mergeDelta: bucket.mergeDelta,
      adEntitlementDelta: bucket.adEntitlementDelta,
      updatedAt: Date.now(),
    }));

  replaceHourlyMetrics(gameKey, metrics);
  return metrics;
}

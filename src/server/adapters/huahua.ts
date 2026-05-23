import type { PlayerFacts, RawSnapshot } from '../../shared/types';
import { toShanghaiDateKey } from '../time';

function parseJson(value: string | undefined): any {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readCurrency(save: any): Record<string, any> {
  return save?.currency || save?.currencies || save?.state?.currency || {};
}

function sumObjectNumbers(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (total, item) => total + toNumber(item),
    0,
  );
}

export function parseHuahuaSnapshot(snapshot: RawSnapshot): PlayerFacts {
  const payload = snapshot.payload;
  const save = parseJson(payload.huahua_save);
  const mergeStats = parseJson(payload.huahua_merge_stats);
  const checkin = parseJson(payload.huahua_checkin);
  const quests = parseJson(payload.huahua_quests);
  const events = parseJson(payload.huahua_events);
  const adEntitlements = parseJson(payload.huahua_ad_entitlements);
  const tutorial = parseJson(payload.huahua_tutorial);

  const currency = readCurrency(save);
  const maxAllowedActiveAt = Date.now() + 10 * 60 * 1000;
  // 客户端存档时间可能受玩家设备时间影响写到未来，超过当前拉取时间 10 分钟的值不参与最后活跃计算。
  const activeTimestamp = [
    toNumber(save.timestamp),
    toNumber(snapshot.lastWriteAt),
    toNumber(snapshot.updatedAt),
  ].reduce((max, ts) => (ts > 0 && ts <= maxAllowedActiveAt ? Math.max(max, ts) : max), 0) || Date.now();

  return {
    gameKey: snapshot.gameKey,
    userId: snapshot.userId,
    platform: snapshot.platform || 'unknown',
    snapshotUpdatedAt: snapshot.updatedAt,
    lastWriteAt: snapshot.lastWriteAt,
    level: toNumber(currency.level ?? currency.starLevel ?? save.level),
    star: toNumber(currency.star ?? currency.globalStar ?? currency.globalStars),
    flowerWish: toNumber(currency.flowerWish ?? currency.coin ?? currency.coins),
    diamond: toNumber(currency.diamond ?? currency.diamonds),
    energy: toNumber(currency.energy),
    mergeCountTotal: toNumber(
      mergeStats.totalMergeCount ?? mergeStats.mergeCountTotal ?? mergeStats.totalMerges,
    ),
    mergeCountToday: toNumber(
      mergeStats.todayMergeCount ?? mergeStats.mergeCountToday ?? mergeStats.dailyMergeCount,
    ),
    deliveredOrdersTotal: toNumber(
      mergeStats.totalDeliveredOrders
        ?? mergeStats.deliveredOrdersTotal
        ?? mergeStats.totalOrderDelivered
        ?? mergeStats.totalOrders,
    ),
    checkinTotalDays: toNumber(
      checkin.totalSignedDays
        ?? checkin.totalDays
        ?? checkin.totalCheckinDays
        ?? checkin.signDays
        ?? checkin.signedDays,
    ),
    checkinStreakDays: toNumber(
      checkin.consecutiveDays
        ?? checkin.streakDays
        ?? checkin.continuousDays,
    ),
    questWeeklyPoints: toNumber(quests.weeklyPoints ?? quests.weekPoints ?? quests.weekScore),
    eventPoints: toNumber(events.points ?? events.score ?? events.eventPoints),
    adEntitlementUsedToday: sumObjectNumbers(adEntitlements.used ?? adEntitlements.dailyUsed),
    tutorialStep: String(tutorial.step ?? tutorial.currentStep ?? (tutorial || '')),
    activeDate: toShanghaiDateKey(activeTimestamp),
    raw: {
      save,
      mergeStats,
      checkin,
      quests,
      events,
      adEntitlements,
      tutorial,
    },
  };
}

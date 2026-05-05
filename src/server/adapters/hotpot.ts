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

export function parseHotpotSnapshot(snapshot: RawSnapshot): PlayerFacts {
  const progress = parseJson(snapshot.payload.hotpot_bowl_progress);
  const settings = parseJson(snapshot.payload.hotpot_settings);
  const currentLevel = toNumber(progress.levelIndex) + 1;
  const maxUnlockedLevel = toNumber(progress.maxUnlockedLevelIndex, toNumber(progress.levelIndex)) + 1;
  const maxUnlockedBadgeLevel = toNumber(progress.maxUnlockedBadgeLevelNumber);
  const activeTimestamp = Math.max(snapshot.lastWriteAt, snapshot.updatedAt);

  return {
    gameKey: snapshot.gameKey,
    userId: snapshot.userId,
    platform: snapshot.platform || 'unknown',
    snapshotUpdatedAt: snapshot.updatedAt,
    lastWriteAt: snapshot.lastWriteAt,
    level: maxUnlockedLevel,
    star: maxUnlockedBadgeLevel,
    flowerWish: 0,
    diamond: 0,
    energy: 0,
    mergeCountTotal: 0,
    mergeCountToday: 0,
    deliveredOrdersTotal: 0,
    checkinTotalDays: 0,
    checkinStreakDays: 0,
    questWeeklyPoints: 0,
    eventPoints: 0,
    adEntitlementUsedToday: 0,
    tutorialStep: '',
    activeDate: toShanghaiDateKey(activeTimestamp),
    raw: {
      progress: {
        ...progress,
        currentLevel,
        maxUnlockedLevel,
        maxUnlockedBadgeLevel,
      },
      settings,
    },
  };
}

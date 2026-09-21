/**
 * 灵宠消消塔2（petTower）玩家档案快照拉取 job
 *
 * 云集合约定（CloudBase 集合名按 GAME_KEY.toLowerCase()）：
 *   微信 pettower_playerData / 抖音 pettower_tt_playerData
 *   Tap pettower_tap_playerData / 华为 pettower_hw_playerData
 *
 * payload 里存档键仍是客户端 camelCase：`petTower_tt_save_v2`。
 */

import { findAnalyticsGame } from '../config/analytics-games';
import { getTcbApp } from '../tcb-client';
import { normalizePlatformFilter, playerDataCollection } from '../../shared/platforms';
import {
  createSnapshotRun,
  finishSnapshotRun,
  pruneOldSnapshots,
  toShanghaiDateKey,
  upsertPetTowerPlayerSnapshots,
  type PetTowerPlayerSnapshotRow,
} from '../snapshot-db';

const PAGE_SIZE = 200;
const DEFAULT_RETENTION_DAYS = 30;
const GAME_KEY = 'petTower';

type UserPrefix = 'wx' | 'dy' | 'tap' | 'hw';

export interface PetTowerSnapshotIngestResult {
  ok: boolean;
  game_key: string;
  snapshot_date: string;
  fetched: number;
  inserted: number;
  pruned_old_rows: number;
  duration_ms: number;
  trigger_source: 'cron' | 'manual';
  collection_name?: string;
  error?: string;
}

function parseJsonString(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toInt(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function asFlag(value: unknown): 0 | 1 {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function inferPlatform(userId: string, docPlatform: unknown): string {
  const raw = String(docPlatform || '').trim();
  if (raw) return raw;
  const id = String(userId || '');
  const idx = id.indexOf(':');
  if (idx > 0) return id.slice(0, idx);
  return 'unknown';
}

/** payload 里找 save_v2 / save_v1，兼容微信 petTower_save_v2 与抖音 petTower_tt_save_v2 */
export function extractPetTowerSave(payload: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(payload);
  const preferred = keys.find((k) => k.endsWith('_save_v2'))
    || keys.find((k) => k.endsWith('_save_v1'));
  if (!preferred) return {};
  return parseJsonString(payload[preferred]);
}

export function parsePetTowerPlayerSnapshot(
  doc: Record<string, unknown>,
  snapshotDate: string,
  forcedUserPrefix?: UserPrefix,
): PetTowerPlayerSnapshotRow | null {
  let userId = String(doc?.userId || '').trim();
  if (!userId) return null;
  if (forcedUserPrefix && !userId.includes(':')) {
    userId = `${forcedUserPrefix}:${userId}`;
  }

  const payload = doc?.payload && typeof doc.payload === 'object' && !Array.isArray(doc.payload)
    ? (doc.payload as Record<string, unknown>)
    : {};
  const save = extractPetTowerSave(payload);
  const stars = parseJsonString(save.stars);
  const ownedPets = parseJsonString(save.ownedPets) as Record<string, { level?: unknown; star?: unknown }>;
  const tutorial = parseJsonString(save.tutorial);
  const checkin = parseJsonString(save.checkin);
  const tower = parseJsonString(save.tower);
  const stamina = parseJsonString(save.stamina);

  let stageClearCount = 0;
  let maxChapter = 0;
  for (const id of Object.keys(stars)) {
    if (id.endsWith('_elite')) continue;
    const m = /^stage_(\d+)_(\d+)$/.exec(id);
    if (!m) continue;
    if (toInt(stars[id]) > 0) {
      stageClearCount += 1;
      maxChapter = Math.max(maxChapter, toInt(m[1]));
    }
  }

  let maxPetLevel = 0;
  let maxPetStar = 0;
  for (const pet of Object.values(ownedPets)) {
    maxPetLevel = Math.max(maxPetLevel, toInt(pet?.level));
    maxPetStar = Math.max(maxPetStar, toInt(pet?.star));
  }

  const tutorialFlagCount = Object.values(tutorial).filter((v) => v === true).length;
  const now = Date.now();
  const maxAllowedActiveAt = now + 10 * 60 * 1000;
  const lastActiveAt = [toInt(doc.updatedAt), toInt(doc.lastWriteAt)]
    .reduce((max, ts) => (ts > 0 && ts <= maxAllowedActiveAt ? Math.max(max, ts) : max), 0) || now;

  return {
    user_id: userId,
    snapshot_date: snapshotDate,
    snapshot_ts: Date.now(),
    platform: forcedUserPrefix || inferPlatform(userId, doc.platform),
    last_active_at: lastActiveAt,
    coins: toInt(save.coins),
    lingyu: toInt(save.lingyu),
    tickets: toInt(save.tickets),
    stamina: toInt(stamina.value),
    owned_pet_count: Object.keys(ownedPets).length,
    max_pet_level: maxPetLevel,
    max_pet_star: maxPetStar,
    recruited_count: toInt(save.recruitedCount),
    stage_clear_count: stageClearCount,
    max_chapter: maxChapter,
    tower_best_floor: toInt(tower.bestFloor),
    checkin_total_days: toInt(checkin.totalDays),
    checkin_streak_days: toInt(checkin.streak),
    tutorial_home_done: asFlag(tutorial.homeStart),
    tutorial_drag_done: asFlag(tutorial.dragHint),
    tutorial_flag_count: tutorialFlagCount,
    desktop_added: asFlag(save.desktopShortcutAdded),
    sidebar_claimed: String(save.sidebarRewardDate || '').trim() ? 1 : 0,
    home_chapter: toInt(save.homeChapter),
  };
}

type CloudDb = {
  collection: (name: string) => {
    skip: (n: number) => { limit: (n: number) => { get: () => Promise<{ data?: unknown[] }> } };
  };
};

async function ingestOneCollection(
  db: CloudDb,
  collection: string,
  snapshotDate: string,
  triggerSource: 'cron' | 'manual',
  options: { forcedUserPrefix?: UserPrefix; filterUserPrefix?: UserPrefix } = {},
): Promise<{ fetched: number; inserted: number; ok: boolean; error?: string }> {
  const runId = await createSnapshotRun(GAME_KEY, collection, snapshotDate, triggerSource);
  let fetched = 0;
  let inserted = 0;
  try {
    let offset = 0;
    while (true) {
      const res = await db.collection(collection).skip(offset).limit(PAGE_SIZE).get();
      const docs = Array.isArray(res.data) ? res.data : [];
      if (docs.length === 0) break;

      const batch: PetTowerPlayerSnapshotRow[] = [];
      for (const doc of docs) {
        try {
          const raw = doc as Record<string, unknown>;
          if (options.filterUserPrefix) {
            const rawUserId = String(raw?.userId || '').trim();
            if (!rawUserId.startsWith(`${options.filterUserPrefix}:`)) continue;
          }
          const row = parsePetTowerPlayerSnapshot(raw, snapshotDate, options.forcedUserPrefix);
          if (row) batch.push(row);
        } catch (err) {
          console.warn(
            `[snapshot] petTower 解析单条失败 collection=${collection} userId=${(doc as Record<string, unknown>)?.userId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (batch.length > 0) {
        inserted += await upsertPetTowerPlayerSnapshots(batch);
      }
      fetched += docs.length;
      offset += docs.length;
      if (docs.length < PAGE_SIZE) break;
    }
    await finishSnapshotRun(runId, 'success', fetched, inserted);
    return { fetched, inserted, ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await finishSnapshotRun(runId, 'failed', fetched, inserted, msg);
    return { fetched, inserted, ok: false, error: msg };
  }
}

export async function ingestPetTowerSnapshots(options: {
  triggerSource: 'cron' | 'manual';
  retentionDays?: number;
  /** wechat / douyin / taptap / huawei；不传则 cron 默认口径 */
  platform?: string;
}): Promise<PetTowerSnapshotIngestResult> {
  const startedAt = Date.now();
  const game = findAnalyticsGame(GAME_KEY);
  if (!game || !game.cloudEnv) {
    throw new Error('petTower 在 ANALYTICS_GAMES 配置里缺少 cloudEnv');
  }
  const snapshotDate = toShanghaiDateKey(startedAt);
  const normalizedPlatform = normalizePlatformFilter(options.platform);
  const mainCollection = playerDataCollection(GAME_KEY, 'wechat');
  const ttCollection = playerDataCollection(GAME_KEY, 'douyin');
  const tapCollection = playerDataCollection(GAME_KEY, 'taptap');
  const hwCollection = playerDataCollection(GAME_KEY, 'huawei');

  let fetched = 0;
  let inserted = 0;
  let pruned = 0;
  const errors: string[] = [];
  const collectionsUsed: string[] = [];

  try {
    const app = getTcbApp(game.cloudEnv);
    const db = app.database();

    const tryOptionalCollection = async (
      collection: string,
      prefix: UserPrefix,
      label: string,
    ) => {
      try {
        console.log(`[snapshot] petTower 尝试拉取集合 ${collection}（${label}，可能尚未建立）`);
        const part = await ingestOneCollection(db, collection, snapshotDate, options.triggerSource, {
          forcedUserPrefix: prefix,
        });
        if (part.fetched > 0 || part.ok) collectionsUsed.push(collection);
        fetched += part.fetched;
        inserted += part.inserted;
        if (!part.ok && part.error) {
          console.warn(`[snapshot] petTower ${collection} 拉取失败（忽略）: ${part.error}`);
        }
      } catch (err) {
        console.warn(
          `[snapshot] petTower ${collection} 不存在或拉取异常（忽略）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    if (normalizedPlatform === 'wechat') {
      console.log(`[snapshot] petTower 拉取集合 ${mainCollection} (platform=wechat)`);
      collectionsUsed.push(mainCollection);
      const part = await ingestOneCollection(db, mainCollection, snapshotDate, options.triggerSource, {
        forcedUserPrefix: 'wx',
        filterUserPrefix: 'wx',
      });
      fetched += part.fetched;
      inserted += part.inserted;
      if (!part.ok && part.error) errors.push(`${mainCollection}: ${part.error}`);
    } else if (normalizedPlatform === 'douyin') {
      console.log(`[snapshot] petTower 拉取集合 ${ttCollection} (platform=douyin)`);
      collectionsUsed.push(ttCollection);
      const ttPart = await ingestOneCollection(db, ttCollection, snapshotDate, options.triggerSource, {
        forcedUserPrefix: 'dy',
      });
      fetched += ttPart.fetched;
      inserted += ttPart.inserted;
      const ttOk = ttPart.ok && ttPart.fetched > 0;
      if (!ttPart.ok && ttPart.error) errors.push(`${ttCollection}: ${ttPart.error}`);

      if (!ttOk) {
        console.log(`[snapshot] petTower ${ttCollection} 拉取失败或为空，回退扫描 ${mainCollection}（只保留 dy: 前缀）`);
        collectionsUsed.push(mainCollection);
        const fallbackPart = await ingestOneCollection(db, mainCollection, snapshotDate, options.triggerSource, {
          filterUserPrefix: 'dy',
        });
        fetched += fallbackPart.fetched;
        inserted += fallbackPart.inserted;
        if (!fallbackPart.ok && fallbackPart.error) errors.push(`${mainCollection}: ${fallbackPart.error}`);
      }
    } else if (normalizedPlatform === 'taptap') {
      console.log(`[snapshot] petTower 拉取集合 ${tapCollection} (platform=taptap)`);
      collectionsUsed.push(tapCollection);
      const part = await ingestOneCollection(db, tapCollection, snapshotDate, options.triggerSource, {
        forcedUserPrefix: 'tap',
      });
      fetched += part.fetched;
      inserted += part.inserted;
      if (!part.ok && part.error) errors.push(`${tapCollection}: ${part.error}`);
    } else if (normalizedPlatform === 'huawei') {
      console.log(`[snapshot] petTower 拉取集合 ${hwCollection} (platform=huawei)`);
      collectionsUsed.push(hwCollection);
      const part = await ingestOneCollection(db, hwCollection, snapshotDate, options.triggerSource, {
        forcedUserPrefix: 'hw',
      });
      fetched += part.fetched;
      inserted += part.inserted;
      if (!part.ok && part.error) errors.push(`${hwCollection}: ${part.error}`);
    } else {
      console.log(`[snapshot] petTower 拉取集合 ${mainCollection} (platform=all)`);
      collectionsUsed.push(mainCollection);
      const mainPart = await ingestOneCollection(db, mainCollection, snapshotDate, options.triggerSource);
      fetched += mainPart.fetched;
      inserted += mainPart.inserted;
      if (!mainPart.ok && mainPart.error) errors.push(`${mainCollection}: ${mainPart.error}`);

      await tryOptionalCollection(ttCollection, 'dy', '抖音 tt');
      await tryOptionalCollection(tapCollection, 'tap', 'Tap');
      await tryOptionalCollection(hwCollection, 'hw', '华为');
    }

    pruned = await pruneOldSnapshots(GAME_KEY, options.retentionDays ?? DEFAULT_RETENTION_DAYS);
    return {
      ok: errors.length === 0,
      game_key: GAME_KEY,
      snapshot_date: snapshotDate,
      fetched,
      inserted,
      pruned_old_rows: pruned,
      duration_ms: Date.now() - startedAt,
      trigger_source: options.triggerSource,
      collection_name: collectionsUsed.join(','),
      error: errors.length > 0 ? errors.join(' | ') : undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      game_key: GAME_KEY,
      snapshot_date: snapshotDate,
      fetched,
      inserted,
      pruned_old_rows: pruned,
      duration_ms: Date.now() - startedAt,
      trigger_source: options.triggerSource,
      collection_name: collectionsUsed.join(','),
      error: msg,
    };
  }
}

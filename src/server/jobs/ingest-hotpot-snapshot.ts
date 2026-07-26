/**
 * 别捞水果（hotpot）玩家档案快照拉取 job
 *
 * 从 CloudBase 存档集合全量分页拉取，解析 payload 中各 JSON 存档键，
 * 写入 hotpot_player_snapshots（每日每用户一行，保留 30 天）。
 *
 * 多平台现状（与 huahua 的关键差异）：
 *   - 微信：hotpot_playerData（userId 前缀 wx:），主集合，永远存在
 *   - 抖音：hotpot_tt_playerData 云端可能还没建（登录仍写主集合，靠 dy: 前缀区分），
 *     所以对 tt 集合一律「尝试拉取，失败/空则跳过」，不能因为它不存在就让整次任务失败
 *
 * 用法：
 *   - cron 自动（不传 platform）：主集合总是拉（含 wx/dy 用户），再尝试拉 tt 集合
 *   - 手动 platform='wechat'：只拉主集合，且只保留 wx: 前缀的行
 *   - 手动 platform='douyin'：优先拉 tt 集合；tt 拉取失败或空，回退扫主集合只保留 dy: 前缀的行
 */

import tcb from '@cloudbase/node-sdk';

import { findAnalyticsGame } from '../config/analytics-games';
import { normalizePlatformFilter, playerDataCollection } from '../../shared/platforms';
import {
  createSnapshotRun,
  finishSnapshotRun,
  pruneOldSnapshots,
  toShanghaiDateKey,
  upsertHotpotPlayerSnapshots,
  type HotpotPlayerSnapshotRow,
} from '../snapshot-db';

const PAGE_SIZE = 200;
const DEFAULT_RETENTION_DAYS = 30;

export interface HotpotSnapshotIngestResult {
  ok: boolean;
  game_key: string;
  snapshot_date: string;
  fetched: number;
  inserted: number;
  pruned_old_rows: number;
  duration_ms: number;
  trigger_source: 'cron' | 'manual';
  /** 本次实际拉取的云集合（多源时逗号拼接） */
  collection_name?: string;
  error?: string;
}

function readCredentials(): { secretId: string; secretKey: string; sessionToken?: string } {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '';
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '';
  const sessionToken = process.env.TENCENTCLOUD_SESSION_TOKEN || process.env.TENCENTCLOUD_TOKEN || '';
  if (!secretId || !secretKey) {
    throw new Error('缺少腾讯云密钥，请在 .env 设置 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY');
  }
  return { secretId, secretKey, sessionToken: sessionToken || undefined };
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

/** 从 userId 推断平台（wx: / dy: / h5: / anon: 前缀） */
function inferPlatform(userId: string, docPlatform: unknown): string {
  const raw = String(docPlatform || '').trim();
  if (raw) return raw;
  const id = String(userId || '');
  const idx = id.indexOf(':');
  if (idx > 0) return id.slice(0, idx);
  return 'unknown';
}

/**
 * 解析单个 hotpot_playerData（或 hotpot_tt_playerData）文档 → 快照行。
 * 存档键与 hot-pot/src/config/CloudConfig.ts 中 GAME_KEY 前缀一致。
 *
 * @param forcedUserPrefix 来源集合对应的档案前缀（wx/dy）；userId 缺前缀时补上，
 *   并强制写入 platform 列——与 parseHuahuaPlayerSnapshot 同款兜底逻辑，
 *   避免云端老档 platform 字段不一致导致按 wx:/dy: 过滤时漏统计。
 */
export function parseHotpotPlayerSnapshot(
  doc: Record<string, unknown>,
  snapshotDate: string,
  forcedUserPrefix?: 'wx' | 'dy',
): HotpotPlayerSnapshotRow | null {
  let userId = String(doc?.userId || '').trim();
  if (!userId) return null;
  if (forcedUserPrefix && !userId.includes(':')) {
    userId = `${forcedUserPrefix}:${userId}`;
  }

  const payload = doc?.payload && typeof doc.payload === 'object' && !Array.isArray(doc.payload)
    ? (doc.payload as Record<string, unknown>)
    : {};

  const wallet = parseJsonString(payload.hotpot_wallet_v1);
  const bowl = parseJsonString(payload.hotpot_bowl_progress);
  const fruit = parseJsonString(payload.hotpot_fruit_slice_progress);
  const gacha = parseJsonString(payload.hotpot_gacha_state_v1);
  const tools = parseJsonString(payload.hotpot_tool_inventory_v1);
  const milkTea = parseJsonString(payload.hotpot_milk_tea_shop_progress_v1);

  const coins = toInt(wallet.coins);
  const coinsTotalEarned = toInt(wallet.totalEarned);
  const coinsTotalSpent = toInt(wallet.totalSpent);
  const bowlBadgeLevel = toInt(bowl.maxUnlockedBadgeLevelNumber);
  const bowlPlayLevelIndex = toInt(bowl.levelIndex ?? bowl.maxUnlockedLevelIndex);
  const fruitBest = toInt(fruit.bestScore);
  const fruitRuns = toInt(fruit.totalRuns);
  const gachaPulls = toInt(gacha.totalPulls);
  const bowlToolTotal = toInt(tools.addDish) + toInt(tools.remove) + toInt(tools.shuffle);
  const milkTeaLevel = toInt(milkTea.shopLevel, 1);
  const milkTeaClears = toInt(milkTea.totalClears);

  const now = Date.now();
  const maxAllowedActiveAt = now + 10 * 60 * 1000;
  const lastActiveAt = [
    toInt(doc.updatedAt),
    toInt(doc.lastWriteAt),
  ].reduce((max, ts) => (ts > 0 && ts <= maxAllowedActiveAt ? Math.max(max, ts) : max), 0) || now;

  const platform = forcedUserPrefix || inferPlatform(userId, doc.platform);

  return {
    user_id: userId,
    snapshot_date: snapshotDate,
    snapshot_ts: Date.now(),
    platform,
    last_active_at: lastActiveAt,
    coins,
    coins_total_earned: coinsTotalEarned,
    coins_total_spent: coinsTotalSpent,
    bowl_badge_level: bowlBadgeLevel,
    bowl_play_level_index: bowlPlayLevelIndex,
    fruit_slice_best_score: fruitBest,
    fruit_slice_total_runs: fruitRuns,
    gacha_total_pulls: gachaPulls,
    bowl_tool_total: bowlToolTotal,
    milk_tea_shop_level: milkTeaLevel,
    milk_tea_total_clears: milkTeaClears,
  };
}

type HotpotDb = {
  collection: (name: string) => {
    skip: (n: number) => { limit: (n: number) => { get: () => Promise<{ data?: unknown[] }> } };
  };
};

/**
 * 拉取单个集合并 upsert。
 *
 * @param forcedUserPrefix 传给 parseHotpotPlayerSnapshot，补前缀 + 覆盖 platform 列
 * @param filterUserPrefix 只有传值时才生效：跳过 userId 不以该前缀开头的行——
 *   用于「hotpot_tt_playerData 尚未分集合，从主集合扫一遍但只保留 dy: 前缀」这种兼容场景
 */
async function ingestOneCollection(
  db: HotpotDb,
  collection: string,
  snapshotDate: string,
  triggerSource: 'cron' | 'manual',
  options: { forcedUserPrefix?: 'wx' | 'dy'; filterUserPrefix?: 'wx' | 'dy' } = {},
): Promise<{ fetched: number; inserted: number; ok: boolean; error?: string }> {
  const runId = await createSnapshotRun('hotpot', collection, snapshotDate, triggerSource);
  let fetched = 0;
  let inserted = 0;
  try {
    let offset = 0;
    while (true) {
      const res = await db.collection(collection).skip(offset).limit(PAGE_SIZE).get();
      const docs = Array.isArray(res.data) ? res.data : [];
      if (docs.length === 0) break;

      const batch: HotpotPlayerSnapshotRow[] = [];
      for (const doc of docs) {
        try {
          if (options.filterUserPrefix) {
            const rawUserId = String((doc as Record<string, unknown>)?.userId || '').trim();
            if (!rawUserId.startsWith(`${options.filterUserPrefix}:`)) continue;
          }
          const row = parseHotpotPlayerSnapshot(
            doc as Record<string, unknown>,
            snapshotDate,
            options.forcedUserPrefix,
          );
          if (row) batch.push(row);
        } catch (err) {
          console.warn(
            `[snapshot] hotpot 解析单条失败 collection=${collection} userId=${(doc as Record<string, unknown>)?.userId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (batch.length > 0) {
        inserted += await upsertHotpotPlayerSnapshots(batch);
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

export async function ingestHotpotSnapshots(options: {
  triggerSource: 'cron' | 'manual';
  retentionDays?: number;
  /** wechat / douyin；不传则 cron 默认口径（主集合总拉 + 尝试拉 tt 集合） */
  platform?: string;
}): Promise<HotpotSnapshotIngestResult> {
  const startedAt = Date.now();
  const game = findAnalyticsGame('hotpot');
  if (!game || !game.cloudEnv) {
    throw new Error('hotpot 在 ANALYTICS_GAMES 配置里缺少 cloudEnv');
  }
  const env = game.cloudEnv;
  const snapshotDate = toShanghaiDateKey(startedAt);
  const normalizedPlatform = normalizePlatformFilter(options.platform);
  const mainCollection = playerDataCollection('hotpot', 'wechat');
  const ttCollection = playerDataCollection('hotpot', 'douyin');

  let fetched = 0;
  let inserted = 0;
  let pruned = 0;
  const errors: string[] = [];
  const collectionsUsed: string[] = [];

  try {
    const { secretId, secretKey, sessionToken } = readCredentials();
    const app = tcb.init({ env, secretId, secretKey, sessionToken });
    const db = app.database();

    if (normalizedPlatform === 'wechat') {
      // 手动指定微信：只拉主集合，且只保留 wx: 前缀，避免把混在主集合里的 dy: 用户也统计进来
      console.log(`[snapshot] hotpot 拉取集合 ${mainCollection} (platform=wechat)`);
      collectionsUsed.push(mainCollection);
      const part = await ingestOneCollection(db, mainCollection, snapshotDate, options.triggerSource, {
        forcedUserPrefix: 'wx',
        filterUserPrefix: 'wx',
      });
      fetched += part.fetched;
      inserted += part.inserted;
      if (!part.ok && part.error) errors.push(`${mainCollection}: ${part.error}`);
    } else if (normalizedPlatform === 'douyin') {
      // 手动指定抖音：优先拉专属 tt 集合；不存在或为空时回退扫主集合，只保留 dy: 前缀的行
      console.log(`[snapshot] hotpot 拉取集合 ${ttCollection} (platform=douyin)`);
      collectionsUsed.push(ttCollection);
      const ttPart = await ingestOneCollection(db, ttCollection, snapshotDate, options.triggerSource, {
        forcedUserPrefix: 'dy',
      });
      fetched += ttPart.fetched;
      inserted += ttPart.inserted;
      const ttOk = ttPart.ok && ttPart.fetched > 0;
      if (!ttPart.ok && ttPart.error) errors.push(`${ttCollection}: ${ttPart.error}`);

      if (!ttOk) {
        console.log(`[snapshot] hotpot ${ttCollection} 拉取失败或为空，回退扫描 ${mainCollection}（只保留 dy: 前缀）`);
        collectionsUsed.push(mainCollection);
        const fallbackPart = await ingestOneCollection(db, mainCollection, snapshotDate, options.triggerSource, {
          filterUserPrefix: 'dy',
        });
        fetched += fallbackPart.fetched;
        inserted += fallbackPart.inserted;
        if (!fallbackPart.ok && fallbackPart.error) errors.push(`${mainCollection}: ${fallbackPart.error}`);
      }
    } else {
      // cron / 未指定 platform：主集合始终拉（含 wx+dy 用户），tt 集合尝试拉取，
      // 失败/不存在只记日志，不让整次任务失败——tt 集合当前可能尚未在云端建出来。
      console.log(`[snapshot] hotpot 拉取集合 ${mainCollection} (platform=all)`);
      collectionsUsed.push(mainCollection);
      const mainPart = await ingestOneCollection(db, mainCollection, snapshotDate, options.triggerSource);
      fetched += mainPart.fetched;
      inserted += mainPart.inserted;
      if (!mainPart.ok && mainPart.error) errors.push(`${mainCollection}: ${mainPart.error}`);

      try {
        console.log(`[snapshot] hotpot 尝试拉取集合 ${ttCollection}（可能尚未建立，失败/空会跳过）`);
        const ttPart = await ingestOneCollection(db, ttCollection, snapshotDate, options.triggerSource, {
          forcedUserPrefix: 'dy',
        });
        if (ttPart.fetched > 0 || ttPart.ok) {
          collectionsUsed.push(ttCollection);
        }
        fetched += ttPart.fetched;
        inserted += ttPart.inserted;
        if (!ttPart.ok && ttPart.error) {
          console.warn(`[snapshot] hotpot tt 集合拉取失败（忽略，不影响整体任务）: ${ttPart.error}`);
        }
      } catch (err) {
        console.warn(
          `[snapshot] hotpot tt 集合不存在或拉取异常（忽略，不影响整体任务）: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    pruned = await pruneOldSnapshots('hotpot', options.retentionDays ?? DEFAULT_RETENTION_DAYS);
    return {
      ok: errors.length === 0,
      game_key: 'hotpot',
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
      game_key: 'hotpot',
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

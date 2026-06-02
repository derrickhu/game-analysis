/**
 * 别捞水果（hotpot）玩家档案快照拉取 job
 *
 * 从 CloudBase hotpot_playerData 全量分页拉取，解析 payload 中各 JSON 存档键，
 * 写入 hotpot_player_snapshots（每日每用户一行，保留 30 天）。
 */

import tcb from '@cloudbase/node-sdk';

import { findAnalyticsGame } from '../config/analytics-games';
import {
  createSnapshotRun,
  finishSnapshotRun,
  pruneOldSnapshots,
  toShanghaiDateKey,
  upsertHotpotPlayerSnapshots,
  type HotpotPlayerSnapshotRow,
} from '../snapshot-db';

const COLLECTION_NAME = 'hotpot_playerData';
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

/** 从 userId 推断平台（wx: / h5: / anon: 前缀） */
function inferPlatform(userId: string, docPlatform: unknown): string {
  const raw = String(docPlatform || '').trim();
  if (raw) return raw;
  const id = String(userId || '');
  const idx = id.indexOf(':');
  if (idx > 0) return id.slice(0, idx);
  return 'unknown';
}

/**
 * 解析单个 hotpot_playerData 文档 → 快照行。
 * 存档键与 hot-pot/src/config/CloudConfig.ts 中 GAME_KEY 前缀一致。
 */
export function parseHotpotPlayerSnapshot(doc: Record<string, unknown>, snapshotDate: string): HotpotPlayerSnapshotRow | null {
  const userId = String(doc?.userId || '').trim();
  if (!userId) return null;

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

  return {
    user_id: userId,
    snapshot_date: snapshotDate,
    snapshot_ts: Date.now(),
    platform: inferPlatform(userId, doc.platform),
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

export async function ingestHotpotSnapshots(options: {
  triggerSource: 'cron' | 'manual';
  retentionDays?: number;
}): Promise<HotpotSnapshotIngestResult> {
  const startedAt = Date.now();
  const game = findAnalyticsGame('hotpot');
  if (!game || !game.cloudEnv) {
    throw new Error('hotpot 在 ANALYTICS_GAMES 配置里缺少 cloudEnv');
  }
  const env = game.cloudEnv;
  const snapshotDate = toShanghaiDateKey(startedAt);
  const runId = await createSnapshotRun('hotpot', COLLECTION_NAME, snapshotDate, options.triggerSource);
  let fetched = 0;
  let inserted = 0;
  let pruned = 0;

  try {
    const { secretId, secretKey, sessionToken } = readCredentials();
    const app = tcb.init({ env, secretId, secretKey, sessionToken });
    const db = app.database();

    let offset = 0;
    while (true) {
      const res = await db.collection(COLLECTION_NAME).skip(offset).limit(PAGE_SIZE).get();
      const docs = Array.isArray(res.data) ? res.data : [];
      if (docs.length === 0) break;

      const batch: HotpotPlayerSnapshotRow[] = [];
      for (const doc of docs) {
        try {
          const row = parseHotpotPlayerSnapshot(doc as Record<string, unknown>, snapshotDate);
          if (row) batch.push(row);
        } catch (err) {
          console.warn(
            `[snapshot] hotpot 解析单条失败 userId=${(doc as Record<string, unknown>)?.userId}: ${
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

    pruned = await pruneOldSnapshots('hotpot', options.retentionDays ?? DEFAULT_RETENTION_DAYS);
    await finishSnapshotRun(runId, 'success', fetched, inserted);
    return {
      ok: true,
      game_key: 'hotpot',
      snapshot_date: snapshotDate,
      fetched,
      inserted,
      pruned_old_rows: pruned,
      duration_ms: Date.now() - startedAt,
      trigger_source: options.triggerSource,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await finishSnapshotRun(runId, 'failed', fetched, inserted, msg);
    return {
      ok: false,
      game_key: 'hotpot',
      snapshot_date: snapshotDate,
      fetched,
      inserted,
      pruned_old_rows: pruned,
      duration_ms: Date.now() - startedAt,
      trigger_source: options.triggerSource,
      error: msg,
    };
  }
}

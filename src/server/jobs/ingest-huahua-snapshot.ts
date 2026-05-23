/**
 * 花花玩家档案快照拉取 job
 *
 * 流程：
 *   1. 用同款 CloudBase node SDK 凭证连 huahua_playerData 集合
 *   2. 分页全量扫表（pageSize=200，1k 用户大约 5 次 RTT，~3 秒）
 *   3. 每个 doc 通过 parseHuahuaPlayerSnapshot 抽取扁平化字段
 *   4. 批量 upsert 到 huahua_player_snapshots 表，主键 (user_id, snapshot_date)
 *   5. 顺手 prune 30 天前的旧快照
 *
 * 设计取舍：
 *   - 全量覆盖：玩家数据每天只拉 1 次，全量比增量简单；活跃 1k 用户也就 ~30k 行/月
 *   - 不落原始 payload：huahua_save 等 JSON 长度可达几十 KB，长期存储成本和隐私风险都不划算，
 *     只落"分析维度的扁平整数字段"
 *   - 错误隔离：单条 doc parse 失败不阻塞整个拉取，记日志后跳过
 *
 * 用法：
 *   - cron 自动：scheduler 每日 04:00（上海时区）触发
 *   - 手动触发：POST /api/realtime/snapshot-now { game: 'huahua' }，用于联调和数据修正
 */

import tcb from '@cloudbase/node-sdk';

import { findAnalyticsGame } from '../config/analytics-games';
import {
  createSnapshotRun,
  finishSnapshotRun,
  pruneOldSnapshots,
  toShanghaiDateKey,
  upsertPlayerSnapshots,
  type PlayerSnapshotRow,
} from '../snapshot-db';

const COLLECTION_NAME = 'huahua_playerData';
const PAGE_SIZE = 200;
/** 默认保留 30 天，覆盖月度 KPI 趋势够用 */
const DEFAULT_RETENTION_DAYS = 30;

export interface SnapshotIngestResult {
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

/** 从 .env 读 CloudBase 凭证，与 cloudbase-ingest.ts 同款 */
function readCredentials(): { secretId: string; secretKey: string; sessionToken?: string } {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '';
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '';
  const sessionToken = process.env.TENCENTCLOUD_SESSION_TOKEN || process.env.TENCENTCLOUD_TOKEN || '';
  if (!secretId || !secretKey) {
    throw new Error('缺少腾讯云密钥，请在 .env 设置 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY');
  }
  return { secretId, secretKey, sessionToken: sessionToken || undefined };
}

// ============================================================
// 字段提取：单个 doc → PlayerSnapshotRow
// ============================================================

function parseJsonString(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, any>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(value: unknown, fallback = 0): number {
  return Math.trunc(toNumber(value, fallback));
}

/**
 * 把任意"可能为数组、可能为 set 序列化字典、可能为对象 keys"的字段统一转成长度。
 * 例：decoration.unlocked = ['deco_1', 'deco_2'] → 2
 *     collection.discovered = { flower: ['x','y'], drink: ['a'] } → 3
 *     affinity_cards.owners = { typeId1: { owned: { card_1: {count:1}, card_2: {} } } } → 总和
 */
function lenOfArray(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  return 0;
}

/** 收集 categoryMap → category[] 的所有数组长度求和（图鉴 collection.discovered 这类结构） */
function sumArrayLengths(maybeMap: unknown): number {
  if (!maybeMap || typeof maybeMap !== 'object') return 0;
  let sum = 0;
  for (const v of Object.values(maybeMap as Record<string, unknown>)) {
    if (Array.isArray(v)) sum += v.length;
    else if (v && typeof v === 'object') sum += Object.keys(v).length;
  }
  return sum;
}

/**
 * 熟客卡：affinity_cards 通常是 { owners: { typeId: { owned: { cardId: {count:N} } } } }
 * 数 owned 字典 key 数（不计 count 重复张数，那是事件流的事）
 */
function countAffinityOwnedCards(affinityCardsRaw: any): number {
  const owners = affinityCardsRaw?.owners;
  if (!owners || typeof owners !== 'object') return 0;
  let total = 0;
  for (const owner of Object.values(owners)) {
    const owned = (owner as any)?.owned;
    if (owned && typeof owned === 'object') {
      total += Object.keys(owned).length;
    }
  }
  return total;
}

/**
 * 提取教程步骤：huahua_tutorial 字段在云端实际形态多变（按观察 1k+ 玩家 doc）：
 *   - 主流：裸数字字符串 "99" / "8" / "16"（PersistService 直接 setItem(string)）
 *   - 少量：JSON 对象 {"step": N, "completed": bool}（老/未来格式）
 *   - 极少：完全缺失（payloadKeys 不含 huahua_tutorial）
 *
 * 完成阈值（参见 game2D_huahua/src/managers/TutorialManager.ts）：
 *   - TutorialStep.COMPLETED = 99    新版完成哨兵值
 *   - LEGACY_COMPLETED_THRESHOLD = 19 老版 v2 完成阈值（兼容老档）
 */
const TUTORIAL_COMPLETED_STEP = 99;
const TUTORIAL_LEGACY_COMPLETED_STEP = 19;

function parseTutorial(rawValue: unknown): { step: number; completed: 0 | 1 } {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return { step: 0, completed: 0 };
  }

  // 1) 尝试统一成 number 或 object
  let value: any = rawValue;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // 非 JSON 字符串（如 "STORY_INTRO"）—— 视作未完成
      return { step: 0, completed: 0 };
    }
  }

  // 2) 数字直接当 step（云端最主流的形态）
  if (typeof value === 'number') {
    const step = Math.trunc(value);
    return {
      step,
      completed: step >= TUTORIAL_LEGACY_COMPLETED_STEP ? 1 : 0,
    };
  }

  // 3) 对象形态：{ step: N, completed: bool }
  if (value && typeof value === 'object') {
    if (value.completed === true) {
      return {
        step: toInt(value.step ?? value.currentStep, TUTORIAL_COMPLETED_STEP),
        completed: 1,
      };
    }
    const step = toInt(value.step ?? value.currentStep, 0);
    return {
      step,
      completed: step >= TUTORIAL_LEGACY_COMPLETED_STEP ? 1 : 0,
    };
  }

  return { step: 0, completed: 0 };
}

/**
 * 从 save.customers.list 推算订单池容量。
 * customers 结构：{ list: CustomerSaveEntry[], nextUid, refreshTimer, ... }
 */
function countActiveCustomers(saveRaw: any): number {
  const list = saveRaw?.customers?.list;
  return Array.isArray(list) ? list.length : 0;
}

/**
 * 完整提取一个玩家的 snapshot row。
 * 任何子字段缺失都 fallback 0 / 空，不抛错。
 */
export function parseHuahuaPlayerSnapshot(doc: any, snapshotDate: string): PlayerSnapshotRow | null {
  const userId = String(doc?.userId || '').trim();
  if (!userId) return null;

  const payload = doc?.payload && typeof doc.payload === 'object' ? doc.payload : {};
  const save = parseJsonString(payload.huahua_save);
  const decoration = parseJsonString(payload.huahua_decoration);
  const dressup = parseJsonString(payload.huahua_dressup);
  const mergeStats = parseJsonString(payload.huahua_merge_stats);
  const checkin = parseJsonString(payload.huahua_checkin);
  const quests = parseJsonString(payload.huahua_quests);
  // 教程字段是裸数字字符串（如 "99"），不能走 parseJsonString（会被丢弃成 {}），直接传 raw
  const tutorialRaw = payload.huahua_tutorial;
  const collection = parseJsonString(payload.huahua_collection);
  const affinityCards = parseJsonString(payload.huahua_affinity_cards);

  // 货币（与 adapters/huahua.ts 同款多别名兼容老档）
  const currency = save?.currency || save?.currencies || save?.state?.currency || {};
  const huayuan = toInt(currency.huayuan ?? currency.flowerWish ?? currency.coin ?? currency.coins);
  const diamond = toInt(currency.diamond ?? currency.diamonds);
  const stamina = toInt(currency.stamina ?? currency.energy);
  const star = toInt(currency.star ?? currency.globalStar ?? currency.globalStars);
  const level = toInt(currency.level ?? currency.starLevel ?? save?.level ?? 1);

  // 许愿券：v8 存在 save.flowerSignTickets，老档可能在 currency 里
  const flowerSignTickets = toInt(
    save?.flowerSignTickets ?? currency.flowerSignTickets ?? currency.flowerTickets,
  );

  // 装饰
  const unlockedDecoCount = lenOfArray(decoration.unlocked);
  const unlockedRoomStylesCount = lenOfArray(decoration.unlockedRoomStyles);
  const unlockedOutfitCount = lenOfArray(dressup.unlocked);

  // 累计指标（沿用 adapters/huahua.ts 的多别名）
  const totalMerges = toInt(
    mergeStats.totalMergeCount ?? mergeStats.mergeCountTotal ?? mergeStats.totalMerges,
  );
  const totalOrders = toInt(
    mergeStats.totalDeliveredOrders ??
      mergeStats.deliveredOrdersTotal ??
      mergeStats.totalOrderDelivered ??
      mergeStats.totalOrders,
  );

  // 签到 / 任务
  const checkinTotalDays = toInt(
    checkin.totalSignedDays ??
      checkin.totalDays ??
      checkin.totalCheckinDays ??
      checkin.signDays ??
      checkin.signedDays,
  );
  const checkinStreakDays = toInt(
    checkin.consecutiveDays ?? checkin.streakDays ?? checkin.continuousDays,
  );
  const questWeeklyPoints = toInt(quests.weeklyPoints ?? quests.weekPoints ?? quests.weekScore);

  // 教程
  const { step: tutorialStep, completed: tutorialCompleted } = parseTutorial(tutorialRaw);

  // 收集
  const collectionDiscoveredCount = sumArrayLengths(collection.discovered ?? collection);
  const affinityCardOwnedCount = countAffinityOwnedCards(affinityCards);

  // 订单池
  const activeCustomerCount = countActiveCustomers(save);

  const now = Date.now();
  const maxAllowedActiveAt = now + 10 * 60 * 1000;
  const lastActiveAt = [
    toNumber(save.timestamp),
    toNumber(doc?.lastWriteAt),
    toNumber(doc?.updatedAt),
  ].reduce((max, ts) => (ts > 0 && ts <= maxAllowedActiveAt ? Math.max(max, ts) : max), 0) || now;

  return {
    user_id: userId,
    snapshot_date: snapshotDate,
    snapshot_ts: Date.now(),
    platform: String(doc?.platform || 'unknown'),
    last_active_at: lastActiveAt,
    level,
    star,
    huayuan,
    diamond,
    stamina,
    flower_sign_tickets: flowerSignTickets,
    tutorial_step: tutorialStep,
    tutorial_completed: tutorialCompleted,
    unlocked_deco_count: unlockedDecoCount,
    unlocked_room_styles_count: unlockedRoomStylesCount,
    unlocked_outfit_count: unlockedOutfitCount,
    total_merges: totalMerges,
    total_orders: totalOrders,
    checkin_total_days: checkinTotalDays,
    checkin_streak_days: checkinStreakDays,
    quest_weekly_points: questWeeklyPoints,
    affinity_card_owned_count: affinityCardOwnedCount,
    collection_discovered_count: collectionDiscoveredCount,
    active_customer_count: activeCustomerCount,
  };
}

// ============================================================
// 主入口：拉取 + 入库 + prune
// ============================================================

export async function ingestHuahuaSnapshots(options: {
  triggerSource: 'cron' | 'manual';
  retentionDays?: number;
}): Promise<SnapshotIngestResult> {
  const startedAt = Date.now();
  const game = findAnalyticsGame('huahua');
  if (!game || !game.cloudEnv) {
    throw new Error('huahua 在 ANALYTICS_GAMES 配置里缺少 cloudEnv');
  }
  const env = game.cloudEnv;
  const snapshotDate = toShanghaiDateKey(startedAt);
  const runId = await createSnapshotRun('huahua', COLLECTION_NAME, snapshotDate, options.triggerSource);
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

      const batch: PlayerSnapshotRow[] = [];
      for (const doc of docs) {
        try {
          const row = parseHuahuaPlayerSnapshot(doc, snapshotDate);
          if (row) batch.push(row);
        } catch (err) {
          // 单条失败不阻塞整个拉取，记日志即可——比"全部失败"更安全
          console.warn(
            `[snapshot] 解析单条失败 userId=${(doc as any)?.userId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (batch.length > 0) {
        const n = await upsertPlayerSnapshots('huahua', batch);
        inserted += n;
      }

      fetched += docs.length;
      offset += docs.length;
      if (docs.length < PAGE_SIZE) break;
    }

    pruned = await pruneOldSnapshots('huahua', options.retentionDays ?? DEFAULT_RETENTION_DAYS);
    await finishSnapshotRun(runId, 'success', fetched, inserted);
    return {
      ok: true,
      game_key: 'huahua',
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
      game_key: 'huahua',
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

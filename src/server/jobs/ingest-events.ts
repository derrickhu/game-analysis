import tcb from '@cloudbase/node-sdk';

import {
  ANALYTICS_EVENTS_COLLECTION,
  findAnalyticsGame,
  getEnabledAnalyticsGames,
  type AnalyticsGameConfig,
} from '../config/analytics-games';
import {
  getCursor,
  insertEvents,
  recordIngestRun,
  updateCursor,
  type AnalyticsEventRow,
} from '../analytics-db';
import { recomputeRealtimeAdMinute } from '../metrics/realtime-ad';

const PAGE_SIZE = 200;
const MAX_PAGES_PER_RUN = 25;

interface RawCloudEvent {
  _id?: string;
  event_id?: string;
  event_name?: string;
  event_ts?: number;
  ingest_ts?: number;
  game_key?: string;
  app_version?: string;
  sdk_version?: string;
  platform?: string;
  user_id?: string;
  anonymous_id?: string;
  session_id?: string;
  session_seq?: number;
  device?: {
    brand?: string;
    model?: string;
    system?: string;
    sdk_version?: string;
    screen_w?: number;
    screen_h?: number;
    network?: string;
  };
  params?: Record<string, unknown>;
}

interface IngestSummary {
  gameKey: string;
  fetched: number;
  inserted: number;
  cursorBefore: number;
  cursorAfter: number;
  newAdMinuteRows: number;
}

const tcbAppCache = new Map<string, ReturnType<typeof tcb.init>>();

function getApp(envId: string) {
  const cached = tcbAppCache.get(envId);
  if (cached) return cached;
  const secretId = process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '';
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '';
  const sessionToken = process.env.TENCENTCLOUD_SESSION_TOKEN || process.env.TENCENTCLOUD_TOKEN || '';
  if (!secretId || !secretKey) {
    throw new Error('缺少腾讯云密钥，请设置 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY');
  }
  const app = tcb.init({
    env: envId,
    secretId,
    secretKey,
    sessionToken: sessionToken || undefined,
  });
  tcbAppCache.set(envId, app);
  return app;
}

// 客户端时钟漂移容忍上限：event_ts 最多比服务端"现在"超前 5 分钟。
// 一旦超过（玩家手机时间设错、闹钟拨动等），用 ingest_ts（云函数收到事件时刻的服务端时间）兜底，
// 否则未来时间戳会污染小时桶——曾经触发过 ad_uau=1/active=1 ⇒ 渗透率被算成 100% 的发版误报。
const FUTURE_EVENT_TS_TOLERANCE_MS = 5 * 60_000;

function normalizeRawEvent(doc: RawCloudEvent): AnalyticsEventRow | null {
  const eventId = (doc.event_id || doc._id || '').toString();
  if (!eventId) return null;
  if (!doc.event_name || typeof doc.event_name !== 'string') return null;
  if (!doc.game_key || typeof doc.game_key !== 'string') return null;
  if (!Number.isFinite(doc.event_ts)) return null;
  const device = doc.device || {};
  const ingestTs = Number(doc.ingest_ts) || 0;
  const rawEventTs = Number(doc.event_ts);
  // event_ts 不允许越过"现在 + 容忍量"。优先用 ingest_ts 兜底（更接近真实事件时刻）；
  // 没有 ingest_ts 时退化用 Date.now()——这种情况下事件本就是离线补传，时序不准是已知事实。
  const nowMs = Date.now();
  const futureCap = nowMs + FUTURE_EVENT_TS_TOLERANCE_MS;
  const safeEventTs =
    rawEventTs > futureCap ? (ingestTs > 0 && ingestTs <= futureCap ? ingestTs : nowMs) : rawEventTs;
  return {
    event_id: eventId,
    event_name: String(doc.event_name),
    event_ts: safeEventTs,
    ingest_ts: ingestTs,
    game_key: String(doc.game_key),
    app_version: String(doc.app_version || '0.0.0'),
    sdk_version: String(doc.sdk_version || '0.0.0'),
    platform: String(doc.platform || 'unknown'),
    user_id: String(doc.user_id || ''),
    anonymous_id: String(doc.anonymous_id || ''),
    session_id: String(doc.session_id || ''),
    session_seq: Number(doc.session_seq) || 0,
    device_brand: String(device.brand || ''),
    device_model: String(device.model || ''),
    device_system: String(device.system || ''),
    device_screen_w: Number(device.screen_w) || 0,
    device_screen_h: Number(device.screen_h) || 0,
    device_network: String(device.network || 'unknown'),
    params_json: JSON.stringify(doc.params || {}),
    ingested_at: Date.now(),
  };
}

/**
 * 单游戏增量拉取：按 game_key 过滤，ingest_ts > cursor，按 ingest_ts 升序拉到本地。
 *
 * 为何用 ingest_ts 而不是 event_ts 作 cursor：
 * - event_ts 是客户端时间，受客户端时钟、离线缓存延迟上报、批量上报、闹钟拨动影响，
 *   完全不保证单调递增。曾经踩过的坑：seed 测试数据 event_ts 推到当前时间往后 1 分钟，
 *   后续真实玩家事件的 event_ts 比它小，被永远跳过。
 * - ingest_ts 是云函数收到事件那一刻的服务端时间，单调递增（且我们在云函数里做了 +i 偏移），
 *   是 CloudDB 写入时序的可靠 anchor。
 *
 * 实现细节：
 * - 一次最多 MAX_PAGES_PER_RUN * PAGE_SIZE 条，避免单次 cron 阻塞过久
 * - 拉取到的事件本地 INSERT IGNORE，event_id 冲突视为去重（防御性兜底）
 * - 更新 cursor 为本批最大的 ingest_ts
 * - 同时触发分钟级广告聚合 recomputeRealtimeAdMinute（按 event_ts 范围计算桶）
 */
export async function ingestEventsForGame(game: AnalyticsGameConfig): Promise<IngestSummary> {
  const startedAt = Date.now();
  const cursorBefore = await getCursor(game.gameKey);
  const app = getApp(game.cloudEnv);
  const db = app.database();
  const _ = db.command;

  let cursor = cursorBefore;
  let lastEventId = '';
  let totalFetched = 0;
  let totalInserted = 0;
  let minEventTs = Number.POSITIVE_INFINITY;
  let maxEventTs = 0;

  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const res = await db
      .collection(ANALYTICS_EVENTS_COLLECTION)
      .where({
        game_key: game.gameKey,
        ingest_ts: _.gt(cursor),
      })
      .orderBy('ingest_ts', 'asc')
      .limit(PAGE_SIZE)
      .get();

    const docs = (Array.isArray(res.data) ? res.data : []) as RawCloudEvent[];
    if (docs.length === 0) break;

    const rows: AnalyticsEventRow[] = [];
    let pageMaxIngestTs = cursor;
    for (const doc of docs) {
      const normalized = normalizeRawEvent(doc);
      if (!normalized) continue;
      rows.push(normalized);
      if (normalized.ingest_ts > pageMaxIngestTs) {
        pageMaxIngestTs = normalized.ingest_ts;
        lastEventId = normalized.event_id;
      }
      if (normalized.event_ts < minEventTs) minEventTs = normalized.event_ts;
      if (normalized.event_ts > maxEventTs) maxEventTs = normalized.event_ts;
    }

    const inserted = await insertEvents(rows);
    totalFetched += docs.length;
    totalInserted += inserted;
    cursor = pageMaxIngestTs;
    await updateCursor(game.gameKey, cursor, lastEventId);

    if (docs.length < PAGE_SIZE) break;
  }

  let newAdMinuteRows = 0;
  if (totalInserted > 0 && Number.isFinite(minEventTs) && maxEventTs > 0) {
    // 按本批事件的 event_ts 范围重算分钟桶（聚合 key 仍然是 event_ts，因为业务关心的是「事件发生时刻」）
    newAdMinuteRows = await recomputeRealtimeAdMinute(game.gameKey, minEventTs, maxEventTs);
  }

  await recordIngestRun({
    gameKey: game.gameKey,
    startedAt,
    finishedAt: Date.now(),
    status: 'success',
    fetched: totalFetched,
    cursorBefore,
    cursorAfter: cursor,
  });

  return {
    gameKey: game.gameKey,
    fetched: totalFetched,
    inserted: totalInserted,
    cursorBefore,
    cursorAfter: cursor,
    newAdMinuteRows,
  };
}

export async function ingestEventsAllGames(): Promise<IngestSummary[]> {
  // 只拉「已接入 SDK 在产数据」的游戏；未接入的跳过，不浪费 CloudBase API 调用配额
  const summaries: IngestSummary[] = [];
  for (const game of getEnabledAnalyticsGames()) {
    try {
      const summary = await ingestEventsForGame(game);
      summaries.push(summary);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[analytics-ingest] ${game.gameKey} failed:`, msg);
      await recordIngestRun({
        gameKey: game.gameKey,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: 'failed',
        fetched: 0,
        cursorBefore: 0,
        cursorAfter: 0,
        errorMessage: msg,
      }).catch(() => undefined);
    }
  }
  return summaries;
}

/** 给 HTTP 接口用的：按 gameKey 单独触发一次拉取 */
export async function ingestEventsByGameKey(gameKey: string): Promise<IngestSummary> {
  const game = findAnalyticsGame(gameKey);
  if (!game) throw new Error(`unknown analytics game: ${gameKey}`);
  return ingestEventsForGame(game);
}

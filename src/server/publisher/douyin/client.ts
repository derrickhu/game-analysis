import type { DouyinPublisherGameMapping } from './config';
import { getExternalApiToken, upsertExternalApiToken } from '../../external-token-store';
import { toShanghaiDateKey } from '../../time';

interface DouyinAccessTokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

interface DouyinTokenResponse {
  err_no?: number;
  err_tips?: string;
  data?: {
    access_token?: string;
    expires_in?: number;
    expires_at?: number;
  };
}

interface DouyinCapacityBaseResponse {
  err_no?: number;
  err_msg?: string;
  err_tips?: string;
  BaseResp?: {
    StatusCode?: number;
    StatusMessage?: string;
  };
}

/** 流量主广告数据查询：按宿主/系统/渠道/广告位拆开的一天一行。金额单位是元。 */
export interface DouyinPublisherAdDataItem {
  date: string;
  host_app: string;
  os: string;
  channel: string;
  ad_type: string;
  request_pv: number;
  show_pv: number;
  click_pv: number;
  click_rate: number;
  ecpm: number;
  income_before_share: number;
  income_after_share: number;
}

interface DouyinAdIncomeQueryResponse extends DouyinCapacityBaseResponse {
  items?: Array<Record<string, unknown>>;
  itemsList?: Array<Record<string, unknown>>;
  page?: {
    total?: number;
    page_no?: number;
    page_size?: number;
  };
  Page?: {
    total?: number;
  };
}

const tokenCache = new Map<string, DouyinAccessTokenCacheEntry>();
const tokenLocks = new Map<string, Promise<string>>();
const TOKEN_URL = 'https://minigame.zijieapi.com/mgplatform/api/apps/v2/token';
const AD_DATA_URL = 'https://minigame.zijieapi.com/mgplatform/api/apps/ad/income/query';
const PAGE_SIZE = 500;
const MAX_RANGE_DAYS = 31;

function assertCapacityOk(action: string, json: DouyinCapacityBaseResponse): void {
  const statusCode = json.BaseResp?.StatusCode;
  if (statusCode !== undefined && statusCode !== 0) {
    throw new Error(
      `抖音流量主 ${action} 调用失败: ${json.BaseResp?.StatusMessage || statusCode} (StatusCode=${statusCode})`,
    );
  }
  if (json.err_no !== undefined && json.err_no !== 0) {
    throw new Error(
      `抖音流量主 ${action} 调用失败: ${json.err_msg || json.err_tips || json.err_no} (err_no=${json.err_no})`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTokenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /access_token|过期|不正确|11016/.test(message);
}

/** 官方文档：-1 系统错误、11001 appid 无法解析，建议重试。 */
function isRetryableCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /系统错误|appid无法解析|err_no=-1|err_no=11001|StatusCode=-1/.test(message);
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toText(value: unknown): string {
  return String(value ?? '').trim();
}

function parseAdDataItem(row: Record<string, unknown>): DouyinPublisherAdDataItem | null {
  const date = toText(row.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    date,
    host_app: toText(row.host_app),
    os: toText(row.os),
    channel: toText(row.channel),
    ad_type: toText(row.ad_type),
    request_pv: toNumber(row.request_pv),
    show_pv: toNumber(row.show_pv),
    click_pv: toNumber(row.click_pv),
    click_rate: toNumber(row.click_rate),
    ecpm: toNumber(row.ecpm),
    income_before_share: toNumber(row.income_before_share),
    income_after_share: toNumber(row.income_after_share),
  };
}

function listResponseItems(json: DouyinAdIncomeQueryResponse): Record<string, unknown>[] {
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json.itemsList)) return json.itemsList;
  return [];
}

function responseTotal(json: DouyinAdIncomeQueryResponse, fallback: number): number {
  const total = json.page?.total ?? json.Page?.total;
  return Number.isFinite(Number(total)) ? Number(total) : fallback;
}

function addDays(dateKey: string, days: number): string {
  return toShanghaiDateKey(new Date(`${dateKey}T00:00:00+08:00`).getTime() + days * 86_400_000);
}

function splitDateRanges(fromDate: string, toDate: string): Array<{ fromDate: string; toDate: string }> {
  const ranges: Array<{ fromDate: string; toDate: string }> = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    const end = addDays(cursor, MAX_RANGE_DAYS - 1);
    ranges.push({ fromDate: cursor, toDate: end < toDate ? end : toDate });
    cursor = addDays(end, 1);
  }
  return ranges;
}

export async function getDouyinPublisherAccessToken(mapping: DouyinPublisherGameMapping): Promise<string> {
  const pending = tokenLocks.get(mapping.appId);
  if (pending) return pending;
  const next = loadDouyinPublisherAccessToken(mapping).finally(() => {
    tokenLocks.delete(mapping.appId);
  });
  tokenLocks.set(mapping.appId, next);
  return next;
}

async function loadDouyinPublisherAccessToken(mapping: DouyinPublisherGameMapping): Promise<string> {
  const cached = tokenCache.get(mapping.appId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const stored = await getExternalApiToken({
    provider: 'douyin_publisher',
    gameKey: mapping.gameKey,
    subjectId: mapping.appId,
  });
  if (stored?.access_token && stored.expires_at > Date.now() + 60_000) {
    tokenCache.set(mapping.appId, {
      accessToken: stored.access_token,
      expiresAt: stored.expires_at,
    });
    return stored.access_token;
  }

  // 小游戏 token 重复获取会把上一枚有效期缩短到 5 分钟，必须先读缓存再请求。
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GameAnalysisDouyinPublisher/1.0',
    },
    body: JSON.stringify({
      appid: mapping.appId,
      secret: mapping.appSecret,
      grant_type: 'client_credential',
    }),
  });
  const json = (await response.json()) as DouyinTokenResponse;
  const accessToken = json.data?.access_token;
  if (!response.ok || json.err_no !== 0 || !accessToken) {
    throw new Error(`抖音小游戏 access_token 获取失败: ${json.err_tips || response.statusText}`);
  }

  const expiresIn = Math.max(60, Number(json.data?.expires_in || 7200));
  const expiresAt = Date.now() + (expiresIn - 60) * 1000;
  tokenCache.set(mapping.appId, { accessToken, expiresAt });
  await upsertExternalApiToken({
    provider: 'douyin_publisher',
    gameKey: mapping.gameKey,
    subjectId: mapping.appId,
    accessToken,
    expiresAt,
    metadata: { appId: mapping.appId },
  });
  return accessToken;
}

async function invalidateDouyinPublisherToken(mapping: DouyinPublisherGameMapping): Promise<void> {
  tokenCache.delete(mapping.appId);
  await upsertExternalApiToken({
    provider: 'douyin_publisher',
    gameKey: mapping.gameKey,
    subjectId: mapping.appId,
    accessToken: '',
    expiresAt: 0,
    metadata: { appId: mapping.appId, invalidated: true },
  });
}

async function fetchAdIncomePage(input: {
  mapping: DouyinPublisherGameMapping;
  accessToken: string;
  fromDate: string;
  toDate: string;
  pageNo: number;
}): Promise<{ items: DouyinPublisherAdDataItem[]; total: number }> {
  const response = await fetch(AD_DATA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'access-token': input.accessToken,
      'User-Agent': 'GameAnalysisDouyinPublisher/1.0',
    },
    body: JSON.stringify({
      Common: {
        'access-token': input.accessToken,
        mp_id: input.mapping.appId,
      },
      start_date: input.fromDate,
      end_date: input.toDate,
      page_no: input.pageNo,
      page_size: PAGE_SIZE,
      Page: {
        page_no: input.pageNo,
        page_size: PAGE_SIZE,
      },
    }),
  });
  const json = (await response.json()) as DouyinAdIncomeQueryResponse;
  if (!response.ok) {
    throw new Error(`抖音流量主广告数据查询失败: HTTP ${response.status}`);
  }
  assertCapacityOk('ad/income/query', json);

  const items = listResponseItems(json).map(parseAdDataItem).filter((row): row is DouyinPublisherAdDataItem => !!row);
  return { items, total: responseTotal(json, items.length) };
}

async function fetchDouyinPublisherAdDataRange(input: {
  mapping: DouyinPublisherGameMapping;
  fromDate: string;
  toDate: string;
}): Promise<DouyinPublisherAdDataItem[]> {
  const accessToken = await getDouyinPublisherAccessToken(input.mapping);
  const collected: DouyinPublisherAdDataItem[] = [];
  let pageNo = 1;
  let total = Number.POSITIVE_INFINITY;

  while (collected.length < total) {
    const page = await fetchAdIncomePage({
      mapping: input.mapping,
      accessToken,
      fromDate: input.fromDate,
      toDate: input.toDate,
      pageNo,
    });
    if (pageNo === 1) total = page.total;
    collected.push(...page.items);
    if (page.items.length < PAGE_SIZE) break;
    pageNo += 1;
    if (pageNo > 50) {
      throw new Error('抖音流量主广告数据查询分页超过上限');
    }
  }
  return collected;
}

async function fetchDouyinPublisherAdData(input: {
  mapping: DouyinPublisherGameMapping;
  fromDate: string;
  toDate: string;
}): Promise<{ rows: DouyinPublisherAdDataItem[]; total: number }> {
  const rows: DouyinPublisherAdDataItem[] = [];
  for (const range of splitDateRanges(input.fromDate, input.toDate)) {
    rows.push(
      ...(await fetchDouyinPublisherAdDataRange({
        mapping: input.mapping,
        fromDate: range.fromDate,
        toDate: range.toDate,
      })),
    );
  }
  return { rows, total: rows.length };
}

export async function getDouyinPublisherAdIncome(input: {
  mapping: DouyinPublisherGameMapping;
  fromDate: string;
  toDate: string;
}): Promise<{ rows: DouyinPublisherAdDataItem[]; total: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (attempt > 0) {
        await sleep(800 * 2 ** (attempt - 1));
      }
      return await fetchDouyinPublisherAdData(input);
    } catch (error) {
      lastError = error;
      if (isTokenError(error)) {
        await invalidateDouyinPublisherToken(input.mapping);
        continue;
      }
      if (isRetryableCapacityError(error) && attempt < 3) {
        console.warn(
          `[douyin_publisher] ad/income/query 可重试失败 attempt=${attempt + 1}:`,
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

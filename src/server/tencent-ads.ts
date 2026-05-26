import crypto from 'node:crypto';

import { getConfig } from './config';
import type { TencentAdsGameMapping } from './config/tencent-ads';
import { getExternalApiToken, upsertExternalApiToken } from './external-token-store';

export interface TencentAdsDailyReportRow {
  date: string;
  adgroup_id?: number;
  adgroup_name?: string;
  campaign_id?: number;
  campaign_name?: string;
  impression?: number;
  click?: number;
  cost?: number;
  download?: number;
  conversion?: number;
  activation?: number;
}

export interface TencentAdsDailyReportResult {
  rows: TencentAdsDailyReportRow[];
  total: number;
}

interface TencentAdsApiResponse<T> {
  code: number;
  message?: string;
  message_cn?: string;
  data?: T;
  trace_id?: string;
}

interface TencentOauthTokenResponse {
  code?: number;
  message?: string;
  message_cn?: string;
  data?: {
    access_token?: string;
    refresh_token?: string;
    access_token_expires_in?: number;
    refresh_token_expires_in?: number;
  };
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface TencentOauthTokenData {
  access_token?: string;
  refresh_token?: string;
  access_token_expires_in?: number;
  refresh_token_expires_in?: number;
  expires_in?: number;
}

function getSeedToken(mapping: TencentAdsGameMapping): { accessToken?: string; refreshToken?: string } {
  const config = getConfig().tencentAds;
  return {
    accessToken: mapping.accessToken || config.accessToken,
    refreshToken: mapping.refreshToken || config.refreshToken,
  };
}

async function refreshTencentAccessToken(mapping: TencentAdsGameMapping, refreshToken: string): Promise<string> {
  const config = getConfig().tencentAds;
  if (!config.clientId || !config.clientSecret) {
    throw new Error('腾讯广告刷新 token 缺少 client_id/client_secret');
  }

  const url = new URL('https://api.e.qq.com/oauth/token');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('client_secret', config.clientSecret);
  url.searchParams.set('grant_type', 'refresh_token');
  url.searchParams.set('refresh_token', refreshToken);

  const response = await fetch(url, {
    headers: { 'User-Agent': 'GameAnalysisTencentAds/1.0' },
  });
  const json = (await response.json()) as TencentOauthTokenResponse;
  const data = (json.data || json) as TencentOauthTokenData;
  const accessToken = data.access_token;
  const nextRefreshToken = data.refresh_token || refreshToken;
  if (!response.ok || !accessToken) {
    throw new Error(`腾讯广告刷新 token 失败: ${json.message_cn || json.message || response.statusText}`);
  }

  const expiresIn = Number(data.access_token_expires_in || data.expires_in || 86_400);
  await upsertExternalApiToken({
    provider: 'tencent_ads',
    gameKey: mapping.gameKey,
    subjectId: mapping.accountId,
    accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: Date.now() + Math.max(300, expiresIn - 300) * 1000,
    metadata: { accountId: mapping.accountId },
  });
  return accessToken;
}

async function resolveAccessToken(mapping: TencentAdsGameMapping): Promise<string> {
  const stored = await getExternalApiToken({
    provider: 'tencent_ads',
    gameKey: mapping.gameKey,
    subjectId: mapping.accountId,
  });
  if (stored?.access_token && stored.expires_at > Date.now() + 300_000) {
    return stored.access_token;
  }

  const seed = getSeedToken(mapping);
  const refreshToken = stored?.refresh_token || seed.refreshToken;
  if (stored?.access_token && refreshToken) {
    return refreshTencentAccessToken(mapping, refreshToken);
  }

  if (seed.accessToken) {
    await upsertExternalApiToken({
      provider: 'tencent_ads',
      gameKey: mapping.gameKey,
      subjectId: mapping.accountId,
      accessToken: seed.accessToken,
      refreshToken: seed.refreshToken,
      expiresAt: Date.now() + 23 * 60 * 60 * 1000,
      metadata: { accountId: mapping.accountId, seededFromEnv: true },
    });
    return seed.accessToken;
  }

  throw new Error(`腾讯广告 ${mapping.gameKey} 缺少 access_token`);
}

function buildCommonParams(accessToken: string): Record<string, string> {
  return {
    access_token: accessToken,
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: crypto.randomBytes(8).toString('hex'),
  };
}

function apiBaseUrl(): string {
  const version = getConfig().tencentAds.apiVersion || 'v3.0';
  return `https://api.e.qq.com/${version}`;
}

async function requestTencentAds<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const url = new URL(`${apiBaseUrl()}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'GameAnalysisTencentAds/1.0' },
  });
  const json = (await response.json()) as TencentAdsApiResponse<T>;
  if (!response.ok || json.code !== 0) {
    const message = json.message_cn || json.message || `HTTP ${response.status}`;
    throw new Error(`腾讯广告 API ${path} 调用失败: ${message}${json.trace_id ? ` (${json.trace_id})` : ''}`);
  }
  if (!json.data) {
    throw new Error(`腾讯广告 API ${path} 未返回 data`);
  }
  return json.data;
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value);
}

export async function getTencentAdsDailyReport(input: {
  mapping: TencentAdsGameMapping;
  fromDate: string;
  toDate: string;
}): Promise<TencentAdsDailyReportResult> {
  const accessToken = await resolveAccessToken(input.mapping);
  const useAdgroupLevel = input.mapping.adgroupIds.length > 0;
  const fields = useAdgroupLevel
    ? ['date', 'adgroup_id', 'adgroup_name', 'impression', 'click', 'cost', 'download', 'conversion', 'activation']
    : ['date', 'impression', 'click', 'cost', 'download', 'conversion', 'activation'];
  const groupBy = useAdgroupLevel ? ['date', 'adgroup_id'] : ['date'];
  const filtering = useAdgroupLevel
    ? [
        {
          field: 'adgroup_id',
          operator: input.mapping.adgroupIds.length === 1 ? 'EQUALS' : 'IN',
          values: input.mapping.adgroupIds,
        },
      ]
    : input.mapping.campaignIds.length > 0
      ? [
          {
            field: 'campaign_id',
            operator: input.mapping.campaignIds.length === 1 ? 'EQUALS' : 'IN',
            values: input.mapping.campaignIds,
          },
        ]
      : undefined;

  const rows: TencentAdsDailyReportRow[] = [];
  let page = 1;
  let totalPage = 1;
  do {
    const params: Record<string, string | number> = {
      ...buildCommonParams(accessToken),
      account_id: input.mapping.accountId,
      level: useAdgroupLevel ? 'REPORT_LEVEL_ADGROUP' : 'REPORT_LEVEL_ADVERTISER',
      date_range: jsonParam({ start_date: input.fromDate, end_date: input.toDate }),
      group_by: jsonParam(groupBy),
      fields: jsonParam(fields),
      page,
      page_size: 100,
    };
    if (filtering) params.filtering = jsonParam(filtering);

    const data = await requestTencentAds<{
      list?: TencentAdsDailyReportRow[];
      page_info?: { total_number?: number; total_page?: number };
    }>('daily_reports/get', params);

    rows.push(...(data.list || []));
    totalPage = Math.max(1, Number(data.page_info?.total_page || 1));
    page += 1;
  } while (page <= totalPage);

  return { rows, total: rows.length };
}

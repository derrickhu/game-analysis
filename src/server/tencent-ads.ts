import crypto from 'node:crypto';

import { getConfig } from './config';
import type {
  TencentAdsAudienceInsightDimension,
  TencentAdsCreativeReportLevel,
  TencentAdsGameMapping,
  TencentAdsTargetingTagType,
} from './config/tencent-ads';
import { getExternalApiToken, upsertExternalApiToken } from './external-token-store';

export interface TencentAdsDailyReportRow {
  date: string;
  adgroup_id?: number | string;
  adgroup_name?: string;
  campaign_id?: number | string;
  campaign_name?: string;
  dynamic_creative_id?: number | string;
  dynamic_creative_name?: string;
  component_id?: number | string;
  component_type?: string;
  image_id?: number | string;
  video_id?: number | string;
  site_set?: string;
  impression?: number;
  click?: number;
  cost?: number;
  download?: number;
  conversion?: number;
  activation?: number;
  view_count?: number;
  view_user_count?: number;
  valid_click_count?: number;
  click_user_count?: number;
  download_count?: number;
  conversion_count?: number;
  activated_count?: number;
  install_count?: number;
  [key: string]: unknown;
}

export interface TencentAdsDailyReportResult {
  rows: TencentAdsDailyReportRow[];
  total: number;
}

export interface TencentAdsTargetingTagReportRow {
  date: string;
  gender?: string;
  age?: string;
  region?: string;
  gender_id?: string | number;
  age_id?: string | number;
  region_id?: string | number;
  impression?: number;
  click?: number;
  cost?: number;
  download?: number;
  conversion?: number;
  activation?: number;
  view_count?: number;
  valid_click_count?: number;
  download_count?: number;
  conversion_count?: number;
  activated_count?: number;
  install_count?: number;
  [key: string]: unknown;
}

export interface TencentAdsTargetingTagReportResult {
  type: TencentAdsTargetingTagType;
  rows: TencentAdsTargetingTagReportRow[];
  total: number;
}

export type TencentAdsCreativeReportRow = TencentAdsDailyReportRow;

export interface TencentAdsCreativeReportResult {
  level: TencentAdsCreativeReportLevel;
  rows: TencentAdsCreativeReportRow[];
  total: number;
}

export interface TencentAdsAudienceDistributionRow {
  dimension_value: string;
  percentage: number;
  tgi?: number;
}

export interface TencentAdsAudienceInsightRow {
  dimension_type: TencentAdsAudienceInsightDimension;
  match_rate?: number;
  distribution?: TencentAdsAudienceDistributionRow[];
  [key: string]: unknown;
}

export interface TencentAdsAudienceInsightResult {
  audienceId: string;
  dimensionType: TencentAdsAudienceInsightDimension;
  rows: TencentAdsAudienceInsightRow[];
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

interface TencentReportPage<T> {
  list?: T[];
  page_info?: { total_number?: number; total_num?: number; total_page?: number };
}

function getSeedToken(mapping: TencentAdsGameMapping): { accessToken?: string; refreshToken?: string } {
  const config = getConfig().tencentAds;
  return {
    accessToken: mapping.accessToken || config.accessToken,
    refreshToken: mapping.refreshToken || config.refreshToken,
  };
}

function tencentAdsApiTimeoutMs(): number {
  const value = Number(process.env.TENCENT_ADS_API_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 15_000;
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
    signal: AbortSignal.timeout(tencentAdsApiTimeoutMs()),
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
    ...freshRequestNonce(),
  };
}

function freshRequestNonce(): { timestamp: string; nonce: string } {
  return {
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: crypto.randomBytes(12).toString('hex'),
  };
}

function apiBaseUrl(version?: string): string {
  return `https://api.e.qq.com/${version || getConfig().tencentAds.apiVersion || 'v3.0'}`;
}

async function requestTencentAds<T>(
  path: string,
  params: Record<string, string | number>,
  options: { version?: string } = {},
): Promise<T> {
  const url = new URL(`${apiBaseUrl(options.version)}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'GameAnalysisTencentAds/1.0' },
    signal: AbortSignal.timeout(tencentAdsApiTimeoutMs()),
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

function buildMappingFiltering(mapping: TencentAdsGameMapping): Array<{ field: string; operator: string; values: string[] }> | undefined {
  if (mapping.adgroupIds.length > 0) {
    return [
      {
        field: 'adgroup_id',
        operator: mapping.adgroupIds.length === 1 ? 'EQUALS' : 'IN',
        values: mapping.adgroupIds,
      },
    ];
  }
  if (mapping.campaignIds.length > 0) {
    return [
      {
        field: 'campaign_id',
        operator: mapping.campaignIds.length === 1 ? 'EQUALS' : 'IN',
        values: mapping.campaignIds,
      },
    ];
  }
  return undefined;
}

async function fetchPagedReport<T>(
  path: string,
  baseParams: Record<string, string | number>,
  options: { version?: string } = {},
): Promise<{ rows: T[]; total: number }> {
  const rows: T[] = [];
  let page = 1;
  let totalPage = 1;
  do {
    const data = await requestTencentAds<TencentReportPage<T>>(
      path,
      {
        ...baseParams,
        ...freshRequestNonce(),
        page,
        page_size: 100,
      },
      options,
    );
    rows.push(...(data.list || []));
    totalPage = Math.max(1, Number(data.page_info?.total_page || 1));
    page += 1;
  } while (page <= totalPage);
  return { rows, total: rows.length };
}

export async function getTencentAdsDailyReport(input: {
  mapping: TencentAdsGameMapping;
  fromDate: string;
  toDate: string;
}): Promise<TencentAdsDailyReportResult> {
  const accessToken = await resolveAccessToken(input.mapping);
  const useAdgroupLevel = input.mapping.adgroupIds.length > 0;
  const metricFields = [
    'view_count',
    'view_user_count',
    'valid_click_count',
    'click_user_count',
    'cost',
    'download_count',
    'conversion_count',
    'activated_count',
    'install_count',
  ];
  const fields = useAdgroupLevel ? ['date', 'adgroup_id', 'adgroup_name', ...metricFields] : ['date', ...metricFields];
  const groupBy = useAdgroupLevel ? ['date', 'adgroup_id'] : ['date'];
  const filtering = buildMappingFiltering(input.mapping);

  const params: Record<string, string | number> = {
    ...buildCommonParams(accessToken),
    account_id: input.mapping.accountId,
    level: useAdgroupLevel ? 'REPORT_LEVEL_ADGROUP' : 'REPORT_LEVEL_ADVERTISER',
    date_range: jsonParam({ start_date: input.fromDate, end_date: input.toDate }),
    group_by: jsonParam(groupBy),
    fields: jsonParam(fields),
  };
  if (filtering) params.filtering = jsonParam(filtering);

  return fetchPagedReport<TencentAdsDailyReportRow>('daily_reports/get', params);
}

function targetingTagField(type: TencentAdsTargetingTagType): 'gender_id' | 'age_id' | 'region_id' {
  if (type === 'AGE') return 'age_id';
  if (type === 'REGION') return 'region_id';
  return 'gender_id';
}

export async function getTencentAdsTargetingTagReport(input: {
  mapping: TencentAdsGameMapping;
  fromDate: string;
  toDate: string;
  type: TencentAdsTargetingTagType;
}): Promise<TencentAdsTargetingTagReportResult> {
  const accessToken = await resolveAccessToken(input.mapping);
  const dimensionField = targetingTagField(input.type);
  const filtering = buildMappingFiltering(input.mapping);
  const useAdgroupLevel = input.mapping.adgroupIds.length > 0;
  const groupBy = useAdgroupLevel ? ['date', dimensionField, 'adgroup_id'] : ['date', dimensionField];
  const params: Record<string, string | number> = {
    ...buildCommonParams(accessToken),
    account_id: input.mapping.accountId,
    type: input.type,
    level: useAdgroupLevel ? 'ADGROUP' : 'ADVERTISER',
    date_range: jsonParam({ start_date: input.fromDate, end_date: input.toDate }),
    group_by: jsonParam(groupBy),
    fields: jsonParam(['date', dimensionField, 'view_count', 'valid_click_count', 'cost', 'conversion_count', 'activated_count']),
    adq_accounts_upgrade_enabled: 'true',
  };
  if (filtering) params.filtering = jsonParam(filtering);

  const result = await fetchPagedReport<TencentAdsTargetingTagReportRow>('targeting_tag_reports/get', params);
  return { type: input.type, ...result };
}

function creativeReportFields(level: TencentAdsCreativeReportLevel): { groupBy: string[]; fields: string[] } {
  const baseMetricFields = [
    'view_count',
    'view_user_count',
    'valid_click_count',
    'click_user_count',
    'cost',
    'download_count',
    'conversion_count',
    'activated_count',
    'install_count',
  ];
  if (level === 'REPORT_LEVEL_COMPONENT') {
    return {
      groupBy: ['date', 'adgroup_id', 'dynamic_creative_id', 'component_id', 'component_type'],
      fields: ['date', 'adgroup_id', 'dynamic_creative_id', 'dynamic_creative_name', 'component_id', 'component_type', ...baseMetricFields],
    };
  }
  if (level === 'REPORT_LEVEL_MATERIAL_IMAGE') {
    return {
      groupBy: ['date', 'adgroup_id', 'image_id'],
      fields: ['date', 'adgroup_id', 'image_id', ...baseMetricFields],
    };
  }
  if (level === 'REPORT_LEVEL_MATERIAL_VIDEO') {
    return {
      groupBy: ['date', 'adgroup_id', 'video_id'],
      fields: ['date', 'adgroup_id', 'video_id', ...baseMetricFields],
    };
  }
  return {
    groupBy: ['date', 'adgroup_id', 'dynamic_creative_id'],
    fields: ['date', 'adgroup_id', 'adgroup_name', 'dynamic_creative_id', 'dynamic_creative_name', ...baseMetricFields],
  };
}

export async function getTencentAdsCreativeReport(input: {
  mapping: TencentAdsGameMapping;
  fromDate: string;
  toDate: string;
  level: TencentAdsCreativeReportLevel;
}): Promise<TencentAdsCreativeReportResult> {
  const accessToken = await resolveAccessToken(input.mapping);
  const filtering = buildMappingFiltering(input.mapping);
  const { fields, groupBy } = creativeReportFields(input.level);
  const params: Record<string, string | number> = {
    ...buildCommonParams(accessToken),
    account_id: input.mapping.accountId,
    level: input.level,
    date_range: jsonParam({ start_date: input.fromDate, end_date: input.toDate }),
    group_by: jsonParam(groupBy),
    fields: jsonParam(fields),
  };
  if (filtering) params.filtering = jsonParam(filtering);

  const result = await fetchPagedReport<TencentAdsCreativeReportRow>('daily_reports/get', params);
  return { level: input.level, ...result };
}

export async function getTencentAdsAudienceInsight(input: {
  mapping: TencentAdsGameMapping;
  audienceId: string;
  dimensionType: TencentAdsAudienceInsightDimension;
}): Promise<TencentAdsAudienceInsightResult> {
  const accessToken = await resolveAccessToken(input.mapping);
  const data = await requestTencentAds<{ list?: TencentAdsAudienceInsightRow[] }>(
    'custom_audience_insights/get',
    {
      ...buildCommonParams(accessToken),
      account_id: input.mapping.accountId,
      audience_id: input.audienceId,
      dimension_type: jsonParam([input.dimensionType]),
    },
    { version: 'v1.1' },
  );
  const rows = data.list || [];
  return {
    audienceId: input.audienceId,
    dimensionType: input.dimensionType,
    rows,
    total: rows.length,
  };
}

import type { WechatPublisherGameMapping } from './config/wechat-publisher';
import { getExternalApiToken, upsertExternalApiToken } from './external-token-store';

interface WechatAccessTokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

interface WechatTokenResponse {
  access_token?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

interface WechatPublisherBaseResponse {
  base_resp?: {
    ret?: number;
    err_msg?: string;
  };
  errcode?: number;
  errmsg?: string;
}

export interface WechatPublisherAdposRow {
  slot_id?: number;
  slot_str?: string;
  ad_slot?: string;
  date: string;
  req_succ_count?: number;
  exposure_count?: number;
  exposure_rate?: number;
  click_count?: number;
  click_rate?: number;
  income?: number;
  ecpm?: number;
}

export interface WechatPublisherAdunitRow {
  appid?: string;
  ad_unit_id?: string;
  ad_unit_name?: string;
  stat_item?: WechatPublisherAdposRow;
}

interface WechatPublisherAdposResponse extends WechatPublisherBaseResponse {
  list?: WechatPublisherAdposRow[];
  summary?: {
    req_succ_count?: number;
    exposure_count?: number;
    exposure_rate?: number;
    click_count?: number;
    click_rate?: number;
    income?: number;
    ecpm?: number;
  };
  total_num?: number;
}

interface WechatPublisherAdunitResponse extends WechatPublisherBaseResponse {
  list?: WechatPublisherAdunitRow[];
  total_num?: number;
}

const tokenCache = new Map<string, WechatAccessTokenCacheEntry>();

async function getAccessToken(mapping: WechatPublisherGameMapping): Promise<string> {
  const cached = tokenCache.get(mapping.appId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const stored = await getExternalApiToken({
    provider: 'wechat_publisher',
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

  const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
  url.searchParams.set('grant_type', 'client_credential');
  url.searchParams.set('appid', mapping.appId);
  url.searchParams.set('secret', mapping.appSecret);

  const response = await fetch(url, {
    headers: { 'User-Agent': 'GameAnalysisWechatPublisher/1.0' },
  });
  const json = (await response.json()) as WechatTokenResponse;
  if (!response.ok || !json.access_token) {
    throw new Error(`微信 access_token 获取失败: ${json.errmsg || response.statusText}`);
  }

  const expiresIn = Math.max(60, Number(json.expires_in || 7200));
  const expiresAt = Date.now() + (expiresIn - 60) * 1000;
  tokenCache.set(mapping.appId, {
    accessToken: json.access_token,
    expiresAt,
  });
  await upsertExternalApiToken({
    provider: 'wechat_publisher',
    gameKey: mapping.gameKey,
    subjectId: mapping.appId,
    accessToken: json.access_token,
    expiresAt,
    metadata: { appId: mapping.appId },
  });
  return json.access_token;
}

function assertPublisherResponseOk(action: string, json: WechatPublisherBaseResponse): void {
  const ret = json.base_resp?.ret;
  if (ret !== undefined && ret !== 0) {
    throw new Error(`微信流量主 ${action} 调用失败: ${json.base_resp?.err_msg || ret}`);
  }
  if (json.errcode !== undefined && json.errcode !== 0) {
    throw new Error(`微信流量主 ${action} 调用失败: ${json.errmsg || json.errcode}`);
  }
}

export async function getWechatPublisherAdposGeneral(input: {
  mapping: WechatPublisherGameMapping;
  fromDate: string;
  toDate: string;
}): Promise<{ rows: WechatPublisherAdposRow[]; total: number }> {
  const accessToken = await getAccessToken(input.mapping);
  const rows: WechatPublisherAdposRow[] = [];
  let page = 1;
  let total = 0;

  do {
    const url = new URL('https://api.weixin.qq.com/publisher/stat');
    url.searchParams.set('action', 'publisher_adpos_general');
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', '200');
    url.searchParams.set('start_date', input.fromDate);
    url.searchParams.set('end_date', input.toDate);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'GameAnalysisWechatPublisher/1.0' },
    });
    const json = (await response.json()) as WechatPublisherAdposResponse;
    assertPublisherResponseOk('publisher_adpos_general', json);

    rows.push(...(json.list || []));
    total = Number(json.total_num || rows.length);
    page += 1;
  } while (rows.length < total);

  return { rows, total };
}

export async function getWechatPublisherAdunitGeneral(input: {
  mapping: WechatPublisherGameMapping;
  fromDate: string;
  toDate: string;
}): Promise<{ rows: WechatPublisherAdunitRow[]; total: number }> {
  const accessToken = await getAccessToken(input.mapping);
  const rows: WechatPublisherAdunitRow[] = [];
  let page = 1;
  let total = 0;

  do {
    const url = new URL('https://api.weixin.qq.com/publisher/stat');
    url.searchParams.set('action', 'publisher_adunit_general');
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', '200');
    url.searchParams.set('start_date', input.fromDate);
    url.searchParams.set('end_date', input.toDate);

    const response = await fetch(url, {
      headers: { 'User-Agent': 'GameAnalysisWechatPublisher/1.0' },
    });
    const json = (await response.json()) as WechatPublisherAdunitResponse;
    assertPublisherResponseOk('publisher_adunit_general', json);

    rows.push(...(json.list || []));
    total = Number(json.total_num || rows.length);
    page += 1;
  } while (rows.length < total);

  return { rows, total };
}

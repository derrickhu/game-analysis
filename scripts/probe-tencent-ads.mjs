import 'dotenv/config';

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const API_VERSION = process.env.TENCENT_ADS_API_VERSION || 'v3.0';
const TIMEOUT_SECONDS = String(Math.max(3, Math.min(30, Number(process.env.TENCENT_ADS_PROBE_TIMEOUT_SECONDS) || 12)));

function mask(value) {
  const text = String(value || '');
  return text.length <= 6 ? '***' : `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function shanghaiDate(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseMappings() {
  try {
    const raw = process.env.TENCENT_ADS_GAME_MAPPINGS_JSON || '[]';
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return { error: `TENCENT_ADS_GAME_MAPPINGS_JSON 解析失败: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function curlJson(url) {
  try {
    const raw = execFileSync('curl', ['-sS', '-m', TIMEOUT_SECONDS, url], { encoding: 'utf8' });
    const json = JSON.parse(raw);
    return {
      ok: json.code === 0,
      code: json.code,
      message_cn: json.message_cn || json.message || '',
      trace_id: json.trace_id,
      total: json.data?.page_info?.total_number ?? json.data?.page_info?.total_num,
      total_page: json.data?.page_info?.total_page,
      sample_count: Array.isArray(json.data?.list) ? json.data.list.length : 0,
      sample_keys: Array.isArray(json.data?.list) && json.data.list[0] ? Object.keys(json.data.list[0]) : [],
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
  }
}

function commonParams(mapping) {
  return {
    access_token: mapping.accessToken || process.env.TENCENT_ADS_ACCESS_TOKEN || '',
    timestamp: String(Math.floor(Date.now() / 1000)),
    nonce: crypto.randomBytes(12).toString('hex'),
    account_id: String(mapping.accountId || process.env.TENCENT_ADS_DEFAULT_ACCOUNT_ID || ''),
  };
}

function addFiltering(params, mapping) {
  const adgroupIds = Array.isArray(mapping.adgroupIds) ? mapping.adgroupIds : [];
  const campaignIds = Array.isArray(mapping.campaignIds) ? mapping.campaignIds : [];
  if (adgroupIds.length > 0) {
    params.set(
      'filtering',
      JSON.stringify([{ field: 'adgroup_id', operator: adgroupIds.length === 1 ? 'EQUALS' : 'IN', values: adgroupIds }]),
    );
  } else if (campaignIds.length > 0) {
    params.set(
      'filtering',
      JSON.stringify([{ field: 'campaign_id', operator: campaignIds.length === 1 ? 'EQUALS' : 'IN', values: campaignIds }]),
    );
  }
}

function dailyUrl(mapping, dateKey) {
  const adgroupLevel = Array.isArray(mapping.adgroupIds) && mapping.adgroupIds.length > 0;
  const params = new URLSearchParams({
    ...commonParams(mapping),
    level: adgroupLevel ? 'REPORT_LEVEL_ADGROUP' : 'REPORT_LEVEL_ADVERTISER',
    date_range: JSON.stringify({ start_date: dateKey, end_date: dateKey }),
    group_by: JSON.stringify(adgroupLevel ? ['date', 'adgroup_id'] : ['date']),
    fields: JSON.stringify(
      adgroupLevel
        ? ['date', 'adgroup_id', 'adgroup_name', 'view_count', 'view_user_count', 'valid_click_count', 'click_user_count', 'cost', 'download_count', 'conversion_count', 'activated_count', 'install_count']
        : ['date', 'view_count', 'view_user_count', 'valid_click_count', 'click_user_count', 'cost', 'download_count', 'conversion_count', 'activated_count', 'install_count'],
    ),
    page: '1',
    page_size: '3',
  });
  addFiltering(params, mapping);
  return `https://api.e.qq.com/${API_VERSION}/daily_reports/get?${params.toString()}`;
}

function creativeUrl(mapping, dateKey) {
  const params = new URLSearchParams({
    ...commonParams(mapping),
    level: 'REPORT_LEVEL_DYNAMIC_CREATIVE',
    date_range: JSON.stringify({ start_date: dateKey, end_date: dateKey }),
    group_by: JSON.stringify(['date', 'adgroup_id', 'dynamic_creative_id']),
    fields: JSON.stringify(['date', 'adgroup_id', 'adgroup_name', 'dynamic_creative_id', 'dynamic_creative_name', 'view_count', 'view_user_count', 'valid_click_count', 'click_user_count', 'cost', 'download_count', 'conversion_count', 'activated_count', 'install_count']),
    page: '1',
    page_size: '3',
  });
  addFiltering(params, mapping);
  return `https://api.e.qq.com/${API_VERSION}/daily_reports/get?${params.toString()}`;
}

function targetingUrl(mapping, dateKey) {
  const adgroupLevel = Array.isArray(mapping.adgroupIds) && mapping.adgroupIds.length > 0;
  const params = new URLSearchParams({
    ...commonParams(mapping),
    type: 'GENDER',
    level: adgroupLevel ? 'REPORT_LEVEL_ADGROUP' : 'REPORT_LEVEL_ADVERTISER',
    date_range: JSON.stringify({ start_date: dateKey, end_date: dateKey }),
    group_by: JSON.stringify(['date', 'gender_id']),
    fields: JSON.stringify(['date', 'gender_id', 'view_count', 'valid_click_count', 'cost', 'conversion_count', 'activated_count']),
    page: '1',
    page_size: '3',
  });
  addFiltering(params, mapping);
  return `https://api.e.qq.com/v1.1/targeting_tag_reports/get?${params.toString()}`;
}

const mappingsResult = parseMappings();
if (!Array.isArray(mappingsResult)) {
  console.log(JSON.stringify({ ok: false, error: mappingsResult.error }, null, 2));
  process.exit(1);
}

const gameFilter = process.env.TENCENT_ADS_PROBE_GAME?.trim();
const dateKey = process.env.TENCENT_ADS_PROBE_DATE || shanghaiDate(-2);
const mappings = mappingsResult.filter((mapping) => !gameFilter || mapping.gameKey === gameFilter);

const gateway = curlJson(`https://api.e.qq.com/${API_VERSION}/daily_reports/get`);
const result = {
  ok: true,
  probe_date: dateKey,
  enabled: process.env.TENCENT_ADS_ENABLED === 'true',
  api_version: API_VERSION,
  gateway_reachable: gateway.code === 11005 || gateway.ok,
  gateway,
  mapping_count: mappings.length,
  mappings: mappings.map((mapping) => ({
    game_key: mapping.gameKey,
    account_id: mask(mapping.accountId),
    adgroup_ids: Array.isArray(mapping.adgroupIds) ? mapping.adgroupIds.length : 0,
    campaign_ids: Array.isArray(mapping.campaignIds) ? mapping.campaignIds.length : 0,
    has_access_token: Boolean(mapping.accessToken || process.env.TENCENT_ADS_ACCESS_TOKEN),
    has_refresh_token: Boolean(mapping.refreshToken || process.env.TENCENT_ADS_REFRESH_TOKEN),
    insights_enabled: Boolean(mapping.insights?.enabled),
    daily: curlJson(dailyUrl(mapping, dateKey)),
    creative: curlJson(creativeUrl(mapping, dateKey)),
    targeting: curlJson(targetingUrl(mapping, dateKey)),
  })),
};
result.ok = result.gateway_reachable && result.mappings.every((mapping) => mapping.daily.ok || mapping.creative.ok || mapping.targeting.ok);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

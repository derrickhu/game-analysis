import { getConfig } from '../config';
import type { TencentAdsGameMapping } from '../config/tencent-ads';
import {
  listBusinessDailyInputs,
  replaceTencentAdsDailyReportRawRows,
  upsertBusinessDailyInput,
  type BusinessDailyInputRow,
  type TencentAdsDailyReportRawRow,
} from '../ltv-db';
import { getTencentAdsDailyReport, type TencentAdsDailyReportRow } from '../tencent-ads';
import { toShanghaiDateKey } from '../time';

export interface TencentAdsIngestGameSummary {
  game_key: string;
  account_id: string;
  from_date: string;
  to_date: string;
  fetched_rows: number;
  saved_rows: number;
  skipped: boolean;
  error?: string;
}

export interface TencentAdsIngestSummary {
  ok: boolean;
  from_date: string;
  to_date: string;
  games: TencentAdsIngestGameSummary[];
}

interface AggregatedTencentAdsDaily {
  dateKey: string;
  spendCny: number;
  clicks: number;
  impressions: number;
  activations: number;
  hasClicks: boolean;
  hasImpressions: boolean;
  hasActivations: boolean;
}

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00+08:00`);
  date.setDate(date.getDate() + days);
  return toShanghaiDateKey(date.getTime());
}

function yesterday(): string {
  return toShanghaiDateKey(Date.now() - 86_400_000);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function readReportMetric(row: Record<string, unknown>, fields: string[]): number | null {
  for (const field of fields) {
    const raw = row[field];
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function aggregateDailyRows(rows: TencentAdsDailyReportRow[]): AggregatedTencentAdsDaily[] {
  const byDate = new Map<string, AggregatedTencentAdsDaily>();
  for (const row of rows) {
    const dateKey = row.date;
    if (!dateKey) continue;
    const current =
      byDate.get(dateKey) || {
        dateKey,
        spendCny: 0,
        clicks: 0,
        impressions: 0,
        activations: 0,
        hasClicks: false,
        hasImpressions: false,
        hasActivations: false,
      };
    const record = row as Record<string, unknown>;
    current.spendCny += Number(row.cost || 0) / 100;
    const clicks = readReportMetric(record, ['valid_click_count', 'click']);
    if (clicks !== null) {
      current.clicks += Math.trunc(clicks);
      current.hasClicks = true;
    }
    const impressions = readReportMetric(record, ['view_count', 'impression']);
    if (impressions !== null) {
      current.impressions += Math.trunc(impressions);
      current.hasImpressions = true;
    }
    const activations = readReportMetric(record, ['activated_count', 'activation', 'conversion_count', 'conversion', 'download_count', 'download', 'install_count']);
    if (activations !== null) {
      current.activations += Math.trunc(activations);
      current.hasActivations = true;
    }
    byDate.set(dateKey, current);
  }

  return [...byDate.values()].map((row) => ({
    ...row,
    spendCny: round2(row.spendCny),
  }));
}

function buildRawRows(mapping: TencentAdsGameMapping, rows: TencentAdsDailyReportRow[]): TencentAdsDailyReportRawRow[] {
  const now = Date.now();
  const reportLevel = mapping.adgroupIds.length > 0 ? 'REPORT_LEVEL_ADGROUP' : 'REPORT_LEVEL_ADVERTISER';
  return rows
    .filter((row) => row.date)
    .map((row) => {
      const record = row as unknown as Record<string, unknown>;
      const impression = readReportMetric(record, ['view_count', 'impression']);
      const click = readReportMetric(record, ['valid_click_count', 'click']);
      const activation = readReportMetric(record, ['activated_count', 'activation', 'conversion_count', 'conversion', 'download_count', 'download', 'install_count']);
      const missingFields = [
        ...(impression === null ? ['impression'] : []),
        ...(click === null ? ['click'] : []),
        ...(activation === null ? ['activation'] : []),
      ];
      return {
        game_key: mapping.gameKey,
        account_id: mapping.accountId,
        report_level: reportLevel,
        date_key: row.date,
        adgroup_id: String(row.adgroup_id || 'account'),
        adgroup_name: row.adgroup_name || '',
        cost_cny: round2(Number(row.cost || 0) / 100),
        impression: impression === null ? null : Math.trunc(impression),
        click: click === null ? null : Math.trunc(click),
        activation: activation === null ? null : Math.trunc(activation),
        missing_fields_json: JSON.stringify(missingFields),
        raw_json: JSON.stringify(row),
        updated_at: now,
      };
    });
}

function buildAutoNote(mapping: TencentAdsGameMapping, row: AggregatedTencentAdsDaily): string {
  const target =
    mapping.adgroupIds.length > 0
      ? `adgroup=${mapping.adgroupIds.join(',')}`
      : mapping.campaignIds.length > 0
        ? `campaign=${mapping.campaignIds.join(',')}`
        : 'account';
  const impressions = row.hasImpressions ? String(row.impressions) : '未返回';
  const clicks = row.hasClicks ? String(row.clicks) : '未返回';
  const activations = row.hasActivations ? String(row.activations) : '未返回';
  return `腾讯广告自动补录 ${mapping.accountId}/${target}：曝光 ${impressions}，点击 ${clicks}，激活 ${activations}`;
}

function mergeNote(existing: BusinessDailyInputRow | undefined, autoNote: string): string {
  const existingNote = existing?.note?.trim() || '';
  const manualNote = existingNote
    .split('\n')
    .filter((line) => !line.startsWith('腾讯广告自动补录 '))
    .join('\n')
    .trim();
  return manualNote ? `${manualNote}\n${autoNote}` : autoNote;
}

async function ingestMapping(mapping: TencentAdsGameMapping, fromDate: string, toDate: string): Promise<TencentAdsIngestGameSummary> {
  try {
    const report = await getTencentAdsDailyReport({ mapping, fromDate, toDate });
    await replaceTencentAdsDailyReportRawRows(
      mapping.gameKey,
      mapping.accountId,
      mapping.adgroupIds.length > 0 ? 'REPORT_LEVEL_ADGROUP' : 'REPORT_LEVEL_ADVERTISER',
      fromDate,
      toDate,
      buildRawRows(mapping, report.rows),
    );
    const dailyRows = aggregateDailyRows(report.rows);
    const existingRows = await listBusinessDailyInputs(mapping.gameKey, fromDate, toDate);
    const existingByDate = new Map(existingRows.map((row) => [row.date_key, row]));

    let savedRows = 0;
    for (const row of dailyRows) {
      const existing = existingByDate.get(row.dateKey);
      await upsertBusinessDailyInput({
        game_key: mapping.gameKey,
        date_key: row.dateKey,
        spend_cny: row.spendCny,
        wechat_clicks: row.hasClicks ? row.clicks : Number(existing?.wechat_clicks || 0),
        // 微信真实收入/曝光来自流量主后台或后续收入接口，腾讯投放接口不能覆盖这两个口径。
        wechat_ad_revenue_cny: Number(existing?.wechat_ad_revenue_cny || 0),
        wechat_ad_impressions: Number(existing?.wechat_ad_impressions || 0),
        acquisition_impressions: row.hasImpressions ? row.impressions : Number(existing?.acquisition_impressions || 0),
        acquisition_activations: row.hasActivations ? row.activations : Number(existing?.acquisition_activations || 0),
        acquisition_source: 'tencent_ads',
        note: mergeNote(existing, buildAutoNote(mapping, row)),
      });
      savedRows += 1;
    }

    return {
      game_key: mapping.gameKey,
      account_id: mapping.accountId,
      from_date: fromDate,
      to_date: toDate,
      fetched_rows: report.total,
      saved_rows: savedRows,
      skipped: false,
    };
  } catch (error) {
    return {
      game_key: mapping.gameKey,
      account_id: mapping.accountId,
      from_date: fromDate,
      to_date: toDate,
      fetched_rows: 0,
      saved_rows: 0,
      skipped: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function ingestTencentAdsBusinessInputs(options: {
  fromDate?: string;
  toDate?: string;
  gameKey?: string;
} = {}): Promise<TencentAdsIngestSummary> {
  const config = getConfig().tencentAds;
  const toDate = options.toDate || yesterday();
  const lookbackDays = Math.max(1, Math.min(90, Number(process.env.TENCENT_ADS_INGEST_LOOKBACK_DAYS) || 90));
  const fromDate = options.fromDate || addDays(toDate, -(lookbackDays - 1));

  if (!config.enabled) {
    return { ok: true, from_date: fromDate, to_date: toDate, games: [] };
  }

  const mappings = config.gameMappings.filter((mapping) => !options.gameKey || mapping.gameKey === options.gameKey);
  const games: TencentAdsIngestGameSummary[] = [];
  for (const mapping of mappings) {
    games.push(await ingestMapping(mapping, fromDate, toDate));
  }

  return {
    ok: games.every((game) => !game.error),
    from_date: fromDate,
    to_date: toDate,
    games,
  };
}

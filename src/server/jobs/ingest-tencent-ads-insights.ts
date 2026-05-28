import { getConfig } from '../config';
import type {
  TencentAdsCreativeReportLevel,
  TencentAdsGameMapping,
  TencentAdsTargetingTagType,
} from '../config/tencent-ads';
import {
  replaceTencentAdsAudienceInsightRawRows,
  replaceTencentAdsCreativeReportRawRows,
  replaceTencentAdsTargetingTagReportRawRows,
  type TencentAdsAudienceInsightRawRow,
  type TencentAdsCreativeReportRawRow,
  type TencentAdsTargetingTagReportRawRow,
} from '../ltv-db';
import {
  getTencentAdsAudienceInsight,
  getTencentAdsCreativeReport,
  getTencentAdsTargetingTagReport,
  type TencentAdsCreativeReportRow,
  type TencentAdsTargetingTagReportRow,
} from '../tencent-ads';
import { toShanghaiDateKey } from '../time';

export interface TencentAdsInsightsIngestGameSummary {
  game_key: string;
  account_id: string;
  from_date: string;
  to_date: string;
  targeting_rows: number;
  creative_rows: number;
  audience_rows: number;
  skipped: boolean;
  errors: string[];
}

export interface TencentAdsInsightsIngestSummary {
  ok: boolean;
  from_date: string;
  to_date: string;
  games: TencentAdsInsightsIngestGameSummary[];
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

function readMetric(row: Record<string, unknown>, fields: string[]): number | null {
  for (const field of fields) {
    const raw = row[field];
    if (raw === undefined || raw === null) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return Math.trunc(value);
  }
  return null;
}

function readActivation(row: Record<string, unknown>): number | null {
  return readMetric(row, ['activated_count', 'activation', 'conversion_count', 'conversion', 'download_count', 'download', 'install_count']);
}

function targetingDimensionField(type: TencentAdsTargetingTagType): 'gender_id' | 'age_id' | 'region_id' {
  if (type === 'AGE') return 'age_id';
  if (type === 'REGION') return 'region_id';
  return 'gender_id';
}

function buildTargetingRows(input: {
  mapping: TencentAdsGameMapping;
  reportLevel: string;
  type: TencentAdsTargetingTagType;
  rows: TencentAdsTargetingTagReportRow[];
}): TencentAdsTargetingTagReportRawRow[] {
  const now = Date.now();
  const dimensionField = targetingDimensionField(input.type);
  return input.rows
    .filter((row) => row.date)
    .map((row) => {
      const record = row as Record<string, unknown>;
      const impression = readMetric(record, ['view_count', 'impression']);
      const click = readMetric(record, ['valid_click_count', 'click']);
      const activation = readActivation(record);
      const missingFields = [
        ...(impression === null ? ['impression'] : []),
        ...(click === null ? ['click'] : []),
        ...(activation === null ? ['activation'] : []),
      ];
      return {
        game_key: input.mapping.gameKey,
        account_id: input.mapping.accountId,
        report_level: input.reportLevel,
        date_key: row.date,
        dimension_type: input.type,
        dimension_value: String(record[dimensionField] || 'UNKNOWN'),
        cost_cny: round2(Number(row.cost || 0) / 100),
        impression,
        click,
        activation,
        missing_fields_json: JSON.stringify(missingFields),
        raw_json: JSON.stringify(row),
        updated_at: now,
      };
    });
}

function creativeEntity(level: TencentAdsCreativeReportLevel, row: TencentAdsCreativeReportRow): {
  entityType: string;
  entityId: string;
  entityName: string;
} {
  if (level === 'REPORT_LEVEL_COMPONENT') {
    return {
      entityType: String(row.component_type || 'component'),
      entityId: String(row.component_id || 'UNKNOWN'),
      entityName: String(row.component_type || ''),
    };
  }
  if (level === 'REPORT_LEVEL_MATERIAL_IMAGE') {
    return { entityType: 'image', entityId: String(row.image_id || 'UNKNOWN'), entityName: '' };
  }
  if (level === 'REPORT_LEVEL_MATERIAL_VIDEO') {
    return { entityType: 'video', entityId: String(row.video_id || 'UNKNOWN'), entityName: '' };
  }
  return {
    entityType: 'dynamic_creative',
    entityId: String(row.dynamic_creative_id || 'UNKNOWN'),
    entityName: String(row.dynamic_creative_name || ''),
  };
}

function buildCreativeRows(input: {
  mapping: TencentAdsGameMapping;
  level: TencentAdsCreativeReportLevel;
  rows: TencentAdsCreativeReportRow[];
}): TencentAdsCreativeReportRawRow[] {
  const now = Date.now();
  return input.rows
    .filter((row) => row.date)
    .map((row) => {
      const record = row as Record<string, unknown>;
      const entity = creativeEntity(input.level, row);
      const impression = readMetric(record, ['view_count', 'impression']);
      const click = readMetric(record, ['valid_click_count', 'click']);
      const activation = readActivation(record);
      const missingFields = [
        ...(impression === null ? ['impression'] : []),
        ...(click === null ? ['click'] : []),
        ...(activation === null ? ['activation'] : []),
      ];
      return {
        game_key: input.mapping.gameKey,
        account_id: input.mapping.accountId,
        report_level: input.level,
        date_key: row.date,
        adgroup_id: String(row.adgroup_id || 'UNKNOWN'),
        entity_type: entity.entityType,
        entity_id: entity.entityId,
        entity_name: entity.entityName,
        site_set: String(row.site_set || ''),
        cost_cny: round2(Number(row.cost || 0) / 100),
        impression,
        click,
        activation,
        missing_fields_json: JSON.stringify(missingFields),
        raw_json: JSON.stringify(row),
        updated_at: now,
      };
    });
}

function reportLevelForTargeting(mapping: TencentAdsGameMapping): string {
  return mapping.adgroupIds.length > 0 ? 'ADGROUP' : 'ADVERTISER';
}

async function ingestMapping(mapping: TencentAdsGameMapping, fromDate: string, toDate: string): Promise<TencentAdsInsightsIngestGameSummary> {
  const summary: TencentAdsInsightsIngestGameSummary = {
    game_key: mapping.gameKey,
    account_id: mapping.accountId,
    from_date: fromDate,
    to_date: toDate,
    targeting_rows: 0,
    creative_rows: 0,
    audience_rows: 0,
    skipped: !mapping.insights.enabled,
    errors: [],
  };
  if (!mapping.insights.enabled) return summary;

  const reportLevel = reportLevelForTargeting(mapping);
  for (const type of mapping.insights.targetingTagTypes) {
    try {
      const report = await getTencentAdsTargetingTagReport({ mapping, fromDate, toDate, type });
      const rows = buildTargetingRows({ mapping, reportLevel, type, rows: report.rows });
      summary.targeting_rows += await replaceTencentAdsTargetingTagReportRawRows(
        mapping.gameKey,
        mapping.accountId,
        reportLevel,
        fromDate,
        toDate,
        rows,
        [type],
      );
    } catch (error) {
      summary.errors.push(`targeting:${type}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const level of mapping.insights.creativeReportLevels) {
    try {
      const report = await getTencentAdsCreativeReport({ mapping, fromDate, toDate, level });
      const rows = buildCreativeRows({ mapping, level, rows: report.rows });
      summary.creative_rows += await replaceTencentAdsCreativeReportRawRows(
        mapping.gameKey,
        mapping.accountId,
        level,
        fromDate,
        toDate,
        rows,
      );
    } catch (error) {
      summary.errors.push(`creative:${level}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const audienceRows: TencentAdsAudienceInsightRawRow[] = [];
  for (const audienceId of mapping.insights.audienceIds) {
    for (const dimensionType of mapping.insights.audienceInsightDimensions) {
      try {
        const result = await getTencentAdsAudienceInsight({ mapping, audienceId, dimensionType });
        for (const row of result.rows) {
          const distribution = row.distribution || [];
          for (const item of distribution) {
            audienceRows.push({
              game_key: mapping.gameKey,
              account_id: mapping.accountId,
              audience_id: audienceId,
              dimension_type: row.dimension_type || dimensionType,
              dimension_value: String(item.dimension_value || 'UNKNOWN'),
              match_rate: row.match_rate === undefined ? null : Number(row.match_rate),
              percentage: item.percentage === undefined ? null : Number(item.percentage),
              tgi: item.tgi === undefined ? null : Number(item.tgi),
              raw_json: JSON.stringify({ row, item }),
              updated_at: Date.now(),
            });
          }
        }
      } catch (error) {
        summary.errors.push(`audience:${audienceId}:${dimensionType}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (audienceRows.length > 0) {
    summary.audience_rows = await replaceTencentAdsAudienceInsightRawRows(mapping.gameKey, mapping.accountId, audienceRows);
  }

  summary.skipped = false;
  return summary;
}

export async function ingestTencentAdsInsights(options: {
  fromDate?: string;
  toDate?: string;
  gameKey?: string;
} = {}): Promise<TencentAdsInsightsIngestSummary> {
  const config = getConfig().tencentAds;
  const toDate = options.toDate || yesterday();
  const lookbackDays = Math.max(1, Math.min(90, Number(process.env.TENCENT_ADS_INSIGHTS_LOOKBACK_DAYS) || 7));
  const fromDate = options.fromDate || addDays(toDate, -(lookbackDays - 1));

  if (!config.enabled) {
    return { ok: true, from_date: fromDate, to_date: toDate, games: [] };
  }

  const mappings = config.gameMappings.filter((mapping) => !options.gameKey || mapping.gameKey === options.gameKey);
  const games: TencentAdsInsightsIngestGameSummary[] = [];
  for (const mapping of mappings) {
    games.push(await ingestMapping(mapping, fromDate, toDate));
  }

  return {
    ok: games.every((game) => game.errors.length === 0),
    from_date: fromDate,
    to_date: toDate,
    games,
  };
}

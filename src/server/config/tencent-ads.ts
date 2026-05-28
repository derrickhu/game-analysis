export type TencentAdsTargetingTagType = 'GENDER' | 'AGE' | 'REGION';

export type TencentAdsCreativeReportLevel =
  | 'REPORT_LEVEL_DYNAMIC_CREATIVE'
  | 'REPORT_LEVEL_COMPONENT'
  | 'REPORT_LEVEL_MATERIAL_IMAGE'
  | 'REPORT_LEVEL_MATERIAL_VIDEO';

export type TencentAdsAudienceInsightDimension =
  | 'AGE'
  | 'GENDER'
  | 'EDUCATION'
  | 'RESIDENT_AREA_CODE'
  | 'USER_BUSINESS_INTEREST'
  | 'RELATIONSHIP_STATUS'
  | 'LOCARD_INTEREST'
  | 'LOCARD_BEHAVIOR_CATEGORY';

export interface TencentAdsInsightOptions {
  enabled: boolean;
  targetingTagTypes: TencentAdsTargetingTagType[];
  creativeReportLevels: TencentAdsCreativeReportLevel[];
  audienceIds: string[];
  audienceInsightDimensions: TencentAdsAudienceInsightDimension[];
}

export interface TencentAdsGameMapping {
  gameKey: string;
  accountId: string;
  campaignIds: string[];
  adgroupIds: string[];
  accessToken?: string;
  refreshToken?: string;
  insights: TencentAdsInsightOptions;
}

export interface TencentAdsConfig {
  enabled: boolean;
  apiVersion: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  defaultAccountId?: string;
  defaultInsights: TencentAdsInsightOptions;
  gameMappings: TencentAdsGameMapping[];
}

const DEFAULT_TARGETING_TAG_TYPES: TencentAdsTargetingTagType[] = ['GENDER', 'AGE', 'REGION'];
const DEFAULT_CREATIVE_REPORT_LEVELS: TencentAdsCreativeReportLevel[] = [
  'REPORT_LEVEL_DYNAMIC_CREATIVE',
  'REPORT_LEVEL_MATERIAL_IMAGE',
  'REPORT_LEVEL_MATERIAL_VIDEO',
];
const DEFAULT_AUDIENCE_INSIGHT_DIMENSIONS: TencentAdsAudienceInsightDimension[] = [
  'AGE',
  'GENDER',
  'EDUCATION',
  'RESIDENT_AREA_CODE',
  'USER_BUSINESS_INTEREST',
  'RELATIONSHIP_STATUS',
];

function readOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readBoolean(name: string): boolean {
  return process.env[name] === 'true';
}

function readRequiredString(name: string): string {
  const value = readOptionalString(name);
  if (!value) {
    throw new Error(`缺少必需的腾讯广告配置: ${name}`);
  }
  return value;
}

function assertStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`腾讯广告游戏映射 ${fieldName} 必须是字符串数组`);
  }
  return value;
}

function readOptionalStringArray(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`腾讯广告游戏映射 ${fieldName} 必须是字符串数组`);
  }
  return value;
}

function readCsv(name: string): string[] | undefined {
  const raw = readOptionalString(name);
  if (!raw) return undefined;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickEnumValues<T extends string>(values: string[] | undefined, allowed: readonly T[], fallback: T[]): T[] {
  if (values === undefined) return fallback;
  if (values.length === 0) return [];
  const disabled = new Set(['NONE', 'OFF', 'DISABLED']);
  if (values.some((item) => disabled.has(item.trim().toUpperCase()))) return [];
  const allowedSet = new Set<string>(allowed);
  const out = values.filter((item): item is T => allowedSet.has(item));
  return out.length > 0 ? out : fallback;
}

function buildDefaultInsights(): TencentAdsInsightOptions {
  const targetingTagTypes = pickEnumValues<TencentAdsTargetingTagType>(
    readCsv('TENCENT_ADS_TARGETING_TAG_TYPES'),
    DEFAULT_TARGETING_TAG_TYPES,
    DEFAULT_TARGETING_TAG_TYPES,
  );
  const creativeReportLevels = pickEnumValues<TencentAdsCreativeReportLevel>(
    readCsv('TENCENT_ADS_CREATIVE_REPORT_LEVELS'),
    DEFAULT_CREATIVE_REPORT_LEVELS,
    DEFAULT_CREATIVE_REPORT_LEVELS,
  );
  const audienceInsightDimensions = pickEnumValues<TencentAdsAudienceInsightDimension>(
    readCsv('TENCENT_ADS_AUDIENCE_INSIGHT_DIMENSIONS'),
    DEFAULT_AUDIENCE_INSIGHT_DIMENSIONS,
    DEFAULT_AUDIENCE_INSIGHT_DIMENSIONS,
  );

  return {
    enabled: readBoolean('TENCENT_ADS_INSIGHTS_ENABLED'),
    targetingTagTypes,
    creativeReportLevels,
    audienceIds: readCsv('TENCENT_ADS_AUDIENCE_IDS') || [],
    audienceInsightDimensions,
  };
}

function readOptionalInsights(mapping: Record<string, unknown>, defaults: TencentAdsInsightOptions): TencentAdsInsightOptions {
  const raw = typeof mapping.insights === 'object' && mapping.insights !== null ? (mapping.insights as Record<string, unknown>) : {};
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled;
  const audienceIds = readOptionalStringArray(raw.audienceIds, 'insights.audienceIds');
  return {
    enabled,
    targetingTagTypes: pickEnumValues<TencentAdsTargetingTagType>(
      readOptionalStringArray(raw.targetingTagTypes, 'insights.targetingTagTypes'),
      DEFAULT_TARGETING_TAG_TYPES,
      defaults.targetingTagTypes,
    ),
    creativeReportLevels: pickEnumValues<TencentAdsCreativeReportLevel>(
      readOptionalStringArray(raw.creativeReportLevels, 'insights.creativeReportLevels'),
      DEFAULT_CREATIVE_REPORT_LEVELS,
      defaults.creativeReportLevels,
    ),
    audienceIds: audienceIds === undefined ? defaults.audienceIds : audienceIds,
    audienceInsightDimensions: pickEnumValues<TencentAdsAudienceInsightDimension>(
      readOptionalStringArray(raw.audienceInsightDimensions, 'insights.audienceInsightDimensions'),
      DEFAULT_AUDIENCE_INSIGHT_DIMENSIONS,
      defaults.audienceInsightDimensions,
    ),
  };
}

function readGameMappings(defaultInsights: TencentAdsInsightOptions): TencentAdsGameMapping[] {
  const raw = readOptionalString('TENCENT_ADS_GAME_MAPPINGS_JSON');
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `TENCENT_ADS_GAME_MAPPINGS_JSON 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error('TENCENT_ADS_GAME_MAPPINGS_JSON 必须是数组');
  }

  return parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`腾讯广告游戏映射第 ${index + 1} 项必须是对象`);
    }

    const mapping = item as Record<string, unknown>;
    if (typeof mapping.gameKey !== 'string' || mapping.gameKey.trim() === '') {
      throw new Error(`腾讯广告游戏映射第 ${index + 1} 项缺少 gameKey`);
    }
    if (typeof mapping.accountId !== 'string' || mapping.accountId.trim() === '') {
      throw new Error(`腾讯广告游戏映射第 ${index + 1} 项缺少 accountId`);
    }

    return {
      gameKey: mapping.gameKey.trim(),
      accountId: mapping.accountId.trim(),
      campaignIds: assertStringArray(mapping.campaignIds, 'campaignIds'),
      adgroupIds: assertStringArray(mapping.adgroupIds, 'adgroupIds'),
      accessToken: typeof mapping.accessToken === 'string' && mapping.accessToken.trim() ? mapping.accessToken.trim() : undefined,
      refreshToken: typeof mapping.refreshToken === 'string' && mapping.refreshToken.trim() ? mapping.refreshToken.trim() : undefined,
      insights: readOptionalInsights(mapping, defaultInsights),
    };
  });
}

export function getTencentAdsConfig(): TencentAdsConfig {
  const enabled = readBoolean('TENCENT_ADS_ENABLED');
  const defaultInsights = buildDefaultInsights();

  return {
    enabled,
    apiVersion: readOptionalString('TENCENT_ADS_API_VERSION') || 'v3.0',
    clientId: enabled ? readRequiredString('TENCENT_ADS_CLIENT_ID') : readOptionalString('TENCENT_ADS_CLIENT_ID'),
    clientSecret: enabled
      ? readRequiredString('TENCENT_ADS_CLIENT_SECRET')
      : readOptionalString('TENCENT_ADS_CLIENT_SECRET'),
    accessToken: readOptionalString('TENCENT_ADS_ACCESS_TOKEN'),
    refreshToken: readOptionalString('TENCENT_ADS_REFRESH_TOKEN'),
    defaultAccountId: readOptionalString('TENCENT_ADS_DEFAULT_ACCOUNT_ID'),
    defaultInsights,
    gameMappings: readGameMappings(defaultInsights),
  };
}

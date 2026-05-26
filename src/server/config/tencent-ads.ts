export interface TencentAdsGameMapping {
  gameKey: string;
  accountId: string;
  campaignIds: string[];
  adgroupIds: string[];
  accessToken?: string;
  refreshToken?: string;
}

export interface TencentAdsConfig {
  enabled: boolean;
  apiVersion: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  defaultAccountId?: string;
  gameMappings: TencentAdsGameMapping[];
}

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

function readGameMappings(): TencentAdsGameMapping[] {
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
    };
  });
}

export function getTencentAdsConfig(): TencentAdsConfig {
  const enabled = readBoolean('TENCENT_ADS_ENABLED');

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
    gameMappings: readGameMappings(),
  };
}

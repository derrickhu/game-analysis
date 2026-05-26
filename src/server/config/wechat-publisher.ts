export interface WechatPublisherGameMapping {
  gameKey: string;
  appId: string;
  appSecret: string;
}

export interface WechatPublisherConfig {
  enabled: boolean;
  gameMappings: WechatPublisherGameMapping[];
}

function readOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readBoolean(name: string): boolean {
  return process.env[name] === 'true';
}

function readGameMappings(): WechatPublisherGameMapping[] {
  const raw = readOptionalString('WECHAT_PUBLISHER_GAME_MAPPINGS_JSON');
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `WECHAT_PUBLISHER_GAME_MAPPINGS_JSON 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error('WECHAT_PUBLISHER_GAME_MAPPINGS_JSON 必须是数组');
  }

  return parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`微信流量主游戏映射第 ${index + 1} 项必须是对象`);
    }
    const mapping = item as Record<string, unknown>;
    if (typeof mapping.gameKey !== 'string' || mapping.gameKey.trim() === '') {
      throw new Error(`微信流量主游戏映射第 ${index + 1} 项缺少 gameKey`);
    }
    if (typeof mapping.appId !== 'string' || mapping.appId.trim() === '') {
      throw new Error(`微信流量主游戏映射第 ${index + 1} 项缺少 appId`);
    }
    if (typeof mapping.appSecret !== 'string' || mapping.appSecret.trim() === '') {
      throw new Error(`微信流量主游戏映射第 ${index + 1} 项缺少 appSecret`);
    }

    return {
      gameKey: mapping.gameKey.trim(),
      appId: mapping.appId.trim(),
      appSecret: mapping.appSecret.trim(),
    };
  });
}

export function getWechatPublisherConfig(): WechatPublisherConfig {
  return {
    enabled: readBoolean('WECHAT_PUBLISHER_ENABLED'),
    gameMappings: readGameMappings(),
  };
}

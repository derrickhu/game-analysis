export interface PublisherGameMapping {
  gameKey: string;
  appId: string;
  appSecret: string;
}

export function readOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function readBoolean(name: string): boolean {
  return process.env[name] === 'true';
}

export function readPublisherGameMappings(envName: string, label: string): PublisherGameMapping[] {
  const raw = readOptionalString(envName);
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${envName} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${envName} 必须是数组`);
  }

  return parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`${label}游戏映射第 ${index + 1} 项必须是对象`);
    }
    const mapping = item as Record<string, unknown>;
    if (typeof mapping.gameKey !== 'string' || mapping.gameKey.trim() === '') {
      throw new Error(`${label}游戏映射第 ${index + 1} 项缺少 gameKey`);
    }
    if (typeof mapping.appId !== 'string' || mapping.appId.trim() === '') {
      throw new Error(`${label}游戏映射第 ${index + 1} 项缺少 appId`);
    }
    if (typeof mapping.appSecret !== 'string' || mapping.appSecret.trim() === '') {
      throw new Error(`${label}游戏映射第 ${index + 1} 项缺少 appSecret`);
    }

    return {
      gameKey: mapping.gameKey.trim(),
      appId: mapping.appId.trim(),
      appSecret: mapping.appSecret.trim(),
    };
  });
}

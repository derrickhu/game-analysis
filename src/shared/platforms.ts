/**
 * 经分「渠道平台」统一口径（与 @gp/analytics-sdk PlatformName 对齐）。
 *
 * - 埋点表 analytics_events.platform：wechat / douyin / taptap / huawei / h5 / unknown
 * - 玩家档案 user_id 前缀：wx / dy / tap / hw / h5 / anon
 * - 云存档集合：`{gameKey}_playerData`（微信）/ `_tt_`（抖音）/ `_tap_`（Tap）/ `_hw_`（华为）
 * - 归因表 platform：广告投放商（tencent_ads），与本模块无关
 *
 * 全局筛选按单个平台，避免混算把量级糊在一起。其它游戏复用本文件即可。
 */

export const CHANNEL_PLATFORMS = ['wechat', 'douyin', 'taptap', 'huawei'] as const;

export type PlatformFilter = (typeof CHANNEL_PLATFORMS)[number];
export type AnalyticsPlatform = PlatformFilter | 'h5';

export const DEFAULT_PLATFORM: PlatformFilter = 'wechat';

export const PLATFORM_LABEL: Record<PlatformFilter, string> = {
  wechat: '微信',
  douyin: '抖音',
  taptap: 'TapTap',
  huawei: '华为',
};

export const PLATFORM_OPTIONS: { value: PlatformFilter; label: string }[] = CHANNEL_PLATFORMS.map((value) => ({
  value,
  label: PLATFORM_LABEL[value],
}));

const UI_VALID = new Set<string>(CHANNEL_PLATFORMS);
const SNAPSHOT_PREFIXES = new Set(['wx', 'dy', 'tap', 'hw', 'h5', 'anon']);

export function parsePlatformFromUrl(raw: string | null | undefined): PlatformFilter {
  if (!raw) return DEFAULT_PLATFORM;
  const v = raw.trim().toLowerCase();
  // 旧链接 ?platform=all / h5 一律回退默认微信，不再提供混算入口
  if (UI_VALID.has(v)) return v as PlatformFilter;
  return DEFAULT_PLATFORM;
}

export function isPlatformFilterActive(platform?: string | null): boolean {
  const p = (platform || '').trim().toLowerCase();
  // 兼容旧 API：空 / all 表示不过滤；UI 不会再传 all
  return !!p && p !== 'all';
}

/** 规范化 API 入参：空 / all → ''（表示不过滤）；其余返回小写平台名 */
export function normalizePlatformFilter(platform?: string | null): string {
  const p = (platform || '').trim().toLowerCase();
  if (!p || p === 'all') return '';
  return p;
}

/**
 * SQL 绑定辅助：配合 `AND (? = '' OR platform = ?)` 使用。
 * 不过滤时传 ['', '']，过滤时传 [platform, platform]。
 */
export function platformSqlParams(platform?: string | null): [string, string] {
  const p = normalizePlatformFilter(platform);
  return [p, p];
}

/** 埋点 platform → 玩家档案 user_id 前缀 */
export function platformToSnapshotPrefix(platform?: string | null): string {
  const p = normalizePlatformFilter(platform);
  if (p === 'wechat') return 'wx';
  if (p === 'douyin') return 'dy';
  if (p === 'taptap') return 'tap';
  if (p === 'huawei') return 'hw';
  if (p === 'h5') return 'h5';
  if (SNAPSHOT_PREFIXES.has(p)) return p;
  return '';
}

/**
 * 云存档集合命名约定（与 huahua-api / petTower-api 的 getCollectionName 对齐）：
 *   微信 `{gameKey}_playerData`
 *   抖音 `{gameKey}_tt_playerData`
 *   Tap  `{gameKey}_tap_playerData`
 *   华为 `{gameKey}_hw_playerData`
 *
 * 经分 gameKey 永远用基础名（huahua / hotpot / petTower），不要带 `_tt` / `_tap` / `_hw`。
 */
export function playerDataCollection(gameKey: string, platform?: string | null): string {
  // CloudBase 集合名按 GAME_KEY.toLowerCase()：petTower → pettower_tt_playerData
  const base = String(gameKey || '').trim().toLowerCase() || 'game';
  const p = normalizePlatformFilter(platform);
  if (p === 'douyin') return `${base}_tt_playerData`;
  if (p === 'taptap') return `${base}_tap_playerData`;
  if (p === 'huawei') return `${base}_hw_playerData`;
  return `${base}_playerData`;
}

/** @deprecated 使用 playerDataCollection('huahua', platform) */
export function huahuaPlayerDataCollection(platform?: string | null): string {
  return playerDataCollection('huahua', platform);
}

/** 拼到已有 query string 后面（可为空串） */
export function appendPlatformQuery(queryStr: string, platform: PlatformFilter): string {
  const part = `platform=${encodeURIComponent(platform)}`;
  if (!queryStr) return part;
  return `${queryStr}&${part}`;
}

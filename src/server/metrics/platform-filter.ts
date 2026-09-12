/**
 * 经分 metrics 统一的平台过滤 SQL 片段。
 * 约定：所有读 analytics_events 的查询在 WHERE 末尾追加 PLATFORM_SQL，
 * 参数列表末尾追加 ...platformSqlParams(platform)。
 */
export {
  isPlatformFilterActive,
  normalizePlatformFilter,
  platformSqlParams,
} from '../../shared/platforms';

/** 追加到 WHERE 子句：空串表示不过滤（全部平台） */
export const PLATFORM_SQL = " AND (? = '' OR platform = ?)";

/**
 * 定时预聚合按各渠道分别落库，查询默认读表，
 * 避免「有 platform 就实时重算」变成线上永远慢路径。
 */
export { CHANNEL_PLATFORMS as PRECOMPUTE_PLATFORMS } from '../../shared/platforms';
export type { PlatformFilter as PrecomputePlatform } from '../../shared/platforms';

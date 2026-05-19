/**
 * 统一的 bucket（时间桶）粒度配置 + 工具函数。
 * - 聚合端（metrics/realtime-ad.ts）按这个粒度生成 bucket 行写库
 * - 对外接口端（routes/realtime.ts）按这个粒度切 series 槽位
 * - 任何场景都不应再硬编码 60_000 这种 1 分钟假设
 *
 * 默认落库仍是 5 分钟一格；对外展示可在 5 分钟 / 小时 / 天之间切换。
 */

export const BUCKET_SIZE_MINUTES = 5;
export const BUCKET_SIZE_MS = BUCKET_SIZE_MINUTES * 60_000;
export const HOUR_BUCKET_SIZE_MS = 60 * 60_000;
export const DAY_BUCKET_SIZE_MS = 24 * HOUR_BUCKET_SIZE_MS;

export type TimeGranularity = 'five_min' | 'hour' | 'day';

export const TIME_GRANULARITY_LABELS: Record<TimeGranularity, string> = {
  five_min: '5 分钟',
  hour: '小时',
  day: '天',
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * 时间戳对齐到 bucket 起点（floor），返回 UTC 字符串 YYYY-MM-DDTHH:mm。
 * 例如 BUCKET_SIZE_MINUTES=5 时，2026-05-07T22:03:17 -> 2026-05-07T22:00。
 */
export function tsToBucket(ts: number): string {
  const aligned = Math.floor(ts / BUCKET_SIZE_MS) * BUCKET_SIZE_MS;
  const d = new Date(aligned);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

/** YYYY-MM-DDTHH:mm 反解为 UTC 毫秒（恰好是该 bucket 的起点） */
export function bucketToTs(bucket: string): number {
  return new Date(`${bucket}:00.000Z`).getTime();
}

/**
 * 时间戳对齐到小时起点（floor），返回 UTC 字符串 YYYY-MM-DDTHH:00。
 * 输出格式与 tsToBucket 兼容（都是 YYYY-MM-DDTHH:mm，只是分钟段恒为 00），
 * 前端 formatMinuteLabel 不需要改就能正确渲染。
 */
export function tsToHourBucket(ts: number): string {
  const aligned = Math.floor(ts / HOUR_BUCKET_SIZE_MS) * HOUR_BUCKET_SIZE_MS;
  const d = new Date(aligned);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:00`
  );
}

/** 时间戳对齐到 UTC 自然日起点，输出 YYYY-MM-DDT00:00，保持和其它 bucket 字符串兼容。 */
export function tsToDayBucket(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00`;
}

export function bucketSizeMsForGranularity(granularity: TimeGranularity): number {
  if (granularity === 'day') return DAY_BUCKET_SIZE_MS;
  if (granularity === 'hour') return HOUR_BUCKET_SIZE_MS;
  return BUCKET_SIZE_MS;
}

export function tsToGranularityBucket(ts: number, granularity: TimeGranularity): string {
  if (granularity === 'day') return tsToDayBucket(ts);
  if (granularity === 'hour') return tsToHourBucket(ts);
  return tsToBucket(ts);
}

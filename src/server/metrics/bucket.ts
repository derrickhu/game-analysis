/**
 * 统一的 bucket（时间桶）粒度配置 + 工具函数。
 * - 聚合端（metrics/realtime-ad.ts）按这个粒度生成 bucket 行写库
 * - 对外接口端（routes/realtime.ts）按这个粒度切 series 槽位
 * - 任何场景都不应再硬编码 60_000 这种 1 分钟假设
 *
 * 目前固定 5 分钟一格；如需改动只改这一处，调用方自动跟随。
 */

export const BUCKET_SIZE_MINUTES = 5;
export const BUCKET_SIZE_MS = BUCKET_SIZE_MINUTES * 60_000;

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

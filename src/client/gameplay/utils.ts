/**
 * 玩法面板共享工具：日期格式化、百分比展示、桶 X 轴标签等。
 * 4 个 huahua-* 面板复用一份，避免每个 panel 内联同样的 helper。
 */

/**
 * 5 分钟桶字符串 → 紧凑 X 轴标签（MM-DD HH:mm，本地时区）。
 * 与 LevelProgressPanel 中的 bucketShort 完全一致，行为对齐避免不同 panel X 轴显示差异。
 */
export function bucketShort(bucket: string): string {
  if (!bucket) return '';
  const utcDate = new Date(`${bucket}:00.000Z`);
  if (isNaN(utcDate.getTime())) return bucket;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(utcDate.getMonth() + 1)}-${pad(utcDate.getDate())} ${pad(utcDate.getHours())}:${pad(utcDate.getMinutes())}`;
}

/** 比例（0~1）→ 百分比展示，null/undefined 显示 '-' */
export function formatPercent(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '-';
  return `${(rate * 100).toFixed(digits)}%`;
}

/** 整数千分位逗号分隔 */
export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('zh-CN');
}

/**
 * series 长度 > threshold 时计算 dataZoom 的初始 start，把视野定在最近的 60 个桶上，
 * 避免长窗口（如 1d）下默认全展示导致刻度密集到看不清。
 */
export function defaultZoomStart(seriesLength: number, visibleCount = 60): number {
  if (seriesLength <= visibleCount) return 0;
  return Math.max(0, 100 - (visibleCount / seriesLength) * 100);
}

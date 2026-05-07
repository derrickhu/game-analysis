/**
 * 全局时间窗口工具
 *
 * 顶部 Header 持有 `windowSel` 状态，所有面板（overview / 广告 / 关卡）共用同一个窗口。
 * 这里集中放窗口选项 + 把窗口翻译成后端接口能直接用的 query string，避免各处重复实现。
 */

/** 窗口选项：'today' = 今日 00:00 ~ now（动态），数字 = 滑动相对分钟数 */
export type WindowValue = 'today' | number;

export const WINDOW_OPTIONS: { value: WindowValue; label: string }[] = [
  { value: 'today', label: '今天（自然日）' },
  { value: 30, label: '近 30 分钟' },
  { value: 60, label: '近 1 小时' },
  { value: 360, label: '近 6 小时' },
  { value: 1440, label: '近 24 小时' },
];

export const DEFAULT_WINDOW: WindowValue = 'today';

/** 把毫秒时间戳格式化成后端接口接受的 UTC bucket 字符串 YYYY-MM-DDTHH:mm */
export function tsToUtcBucketStr(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

/**
 * 把窗口选项翻译成后端接口的 query string，三个 realtime 接口（overview / ad-revenue / hotpot-progress）
 * 都接受同样的 from/to/window 三选其一，所以一份就够用。
 *
 * - 'today'：精确传 from=今日本地时区 00:00 + to=now，避免 5 分钟对齐导致前一天数据混入
 * - 数字：传 window=分钟数，让后端按"过去 N 分钟"倒推
 */
export function buildWindowQuery(window: WindowValue): string {
  if (window !== 'today') {
    return `window=${window}`;
  }
  const now = Date.now();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const fromBucket = tsToUtcBucketStr(todayStart.getTime());
  const toBucket = tsToUtcBucketStr(now);
  return `from=${encodeURIComponent(fromBucket)}&to=${encodeURIComponent(toBucket)}`;
}

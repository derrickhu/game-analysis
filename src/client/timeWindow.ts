/**
 * 全局时间窗口工具
 *
 * 顶部 Header 持有 `windowSel` 状态，所有面板（overview / 广告 / 关卡）共用同一个窗口。
 * 这里集中放窗口选项 + 把窗口翻译成后端接口能直接用的 query string，避免各处重复实现。
 *
 * 支持三种语义：
 * - 'today'                            ：自然日（本地时区 00:00 ~ now），默认
 * - number（分钟数）                   ：滑动相对时间，如 30/60/360/1440/10080/43200
 * - { kind: 'range', fromTs, toTs }    ：用户在 RangePicker 里手选的任意时间范围（毫秒时间戳）
 *
 * 任意 number / range 都会被序列化成 from/to query 参数发给后端（不再走 window=N 那条 24h 上限分支），
 * 这样 7 天 / 30 天 / 自定义都能稳定查询，前端只需要更新这一份逻辑。
 */

export interface CustomRangeValue {
  kind: 'range';
  /** 起点（含），毫秒时间戳 */
  fromTs: number;
  /** 终点（含），毫秒时间戳 */
  toTs: number;
}

export type WindowValue = 'today' | number | CustomRangeValue;

/** 窗口下拉的快捷档位；自定义时间范围由外置 RangePicker 承担，这里不再含 'custom' 选项 */
export const WINDOW_OPTIONS: { value: 'today' | number; label: string }[] = [
  { value: 'today', label: '今天（自然日）' },
  { value: 30, label: '近 30 分钟' },
  { value: 60, label: '近 1 小时' },
  { value: 360, label: '近 6 小时' },
  { value: 1440, label: '近 24 小时' },
  { value: 60 * 24 * 7, label: '近 7 天' },
  { value: 60 * 24 * 30, label: '近 30 天' },
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

/** 判断是否是自定义时间范围 */
export function isCustomRange(value: WindowValue): value is CustomRangeValue {
  return typeof value === 'object' && value !== null && (value as CustomRangeValue).kind === 'range';
}

/**
 * 把任意 WindowValue 解析成具体的 [fromTs, toTs] 区间（毫秒），
 * 给外置 RangePicker 做 value 展示用——这样不论用户当前选了快捷档还是自定义档，
 * RangePicker 都能"映射"出对应的具体起止时间，UX 上一目了然。
 *
 * 注意：'today' / 数字档位都基于"当前时刻"展开，重渲染时 toTs 会跟着 now 漂移，
 * 这是预期行为（快捷档本身就是相对时间）；要锁住区间用户应手选自定义。
 */
export function resolveWindow(window: WindowValue): { fromTs: number; toTs: number } {
  const now = Date.now();
  if (window === 'today') {
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    return { fromTs: todayStart.getTime(), toTs: now };
  }
  if (typeof window === 'number') {
    return { fromTs: now - window * 60_000, toTs: now };
  }
  return { fromTs: window.fromTs, toTs: window.toTs };
}

/**
 * 把 WindowValue 序列化成可放进 URL search 参数的字符串。
 * - 'today'           → 'today'
 * - 数字（分钟数）    → '60' / '1440' / '10080' 等
 * - { kind:'range' }  → 'range:fromTs-toTs'（毫秒时间戳）
 *
 * 选择 `kind:value` 的紧凑串而不是 ?from=&to= 双参数，是为了让 URL 一眼能看出窗口类型，
 * 且复制/分享时少一个参数；与 `WindowValue` 类型一一对应，反序列化容错也好写。
 */
export function windowToUrlValue(window: WindowValue): string {
  if (window === 'today') return 'today';
  if (typeof window === 'number') return String(window);
  return `range:${window.fromTs}-${window.toTs}`;
}

/**
 * 解析 URL 中的 window 参数为 WindowValue。
 * 任何不识别 / 缺失 / 非法格式都回退到默认 'today'，避免脏 URL 引发白屏。
 */
export function parseWindowFromUrl(raw: string | null | undefined): WindowValue {
  if (!raw) return DEFAULT_WINDOW;
  if (raw === 'today') return 'today';
  if (raw.startsWith('range:')) {
    const m = /^range:(\d+)-(\d+)$/.exec(raw);
    if (!m) return DEFAULT_WINDOW;
    const fromTs = Number(m[1]);
    const toTs = Number(m[2]);
    if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) {
      return DEFAULT_WINDOW;
    }
    return { kind: 'range', fromTs, toTs };
  }
  const minutes = Number(raw);
  if (Number.isFinite(minutes) && minutes > 0 && minutes < 60 * 24 * 365) {
    return minutes;
  }
  return DEFAULT_WINDOW;
}

/**
 * 把窗口选项翻译成后端接口的 query string。三个 realtime 接口都接受 from/to，
 * 这里统一走 from/to 路径，避免老的 window=N 分钟分支被后端 24h 上限卡死，导致 7/30 天预设无效。
 *
 * - 'today'：精确传 from=今日本地时区 00:00 + to=now
 * - number：from = now - N 分钟，to = now
 * - range ：直接使用用户手选的 fromTs / toTs（已由 UI 兜底校验范围合法）
 */
export function buildWindowQuery(window: WindowValue): string {
  const now = Date.now();
  let fromTs: number;
  let toTs: number;
  if (window === 'today') {
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    fromTs = todayStart.getTime();
    toTs = now;
  } else if (typeof window === 'number') {
    fromTs = now - window * 60_000;
    toTs = now;
  } else {
    fromTs = window.fromTs;
    toTs = window.toTs;
  }
  const fromBucket = tsToUtcBucketStr(fromTs);
  const toBucket = tsToUtcBucketStr(toTs);
  return `from=${encodeURIComponent(fromBucket)}&to=${encodeURIComponent(toBucket)}`;
}

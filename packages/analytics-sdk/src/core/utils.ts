/** 生成 22 字符的 url-safe 随机串作为 event_id / anonymous_id / session_id，碰撞概率可忽略 */
export function randomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 22; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** 当前时间毫秒 */
export function now(): number {
  return Date.now();
}

/** SDK 内部带前缀的日志，便于宿主排查 */
export function debug(scope: string, ...args: unknown[]): void {
  try {
    console.log(`[analytics-sdk:${scope}]`, ...args);
  } catch {
    // 静默失败，避免上报通路本身异常拖垮宿主
  }
}

export function warn(scope: string, ...args: unknown[]): void {
  try {
    console.warn(`[analytics-sdk:${scope}]`, ...args);
  } catch {
    // ignore
  }
}

/** 安全 JSON.stringify，循环引用降级为 null */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return JSON.stringify(value, (_k, v) => {
        if (typeof v === 'object' && v !== null) {
          return Array.isArray(v) ? v.slice(0, 100) : { ...v };
        }
        return v;
      });
    } catch {
      return 'null';
    }
  }
}

/** 安全 JSON.parse，失败返回 null */
export function safeParse<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

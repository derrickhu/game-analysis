import type { StorageAdapter } from '../adapters/types';
import type { AnalyticsEvent } from './EventSchema';
import { safeParse, safeStringify, warn } from './utils';

const PENDING_KEY = '__gp_analytics_pending__';
const DEAD_LETTER_KEY = '__gp_analytics_dead_letter__';

/**
 * 双层事件队列：
 * - 内存队列（events 数组）：fast path，所有 enqueue/take 操作都在内存
 * - 持久化兜底（storage）：onHide 时调用 persist() 把内存队列序列化到 storage；下次 init() 调用 restore() 把 storage 残留并入队
 *
 * 容量保护：
 * - 内存队列超过 maxQueueSize 自动丢弃最旧的（避免内存爆炸）
 * - 持久化队列超过 maxPersistedSize 也丢最旧的（避免 storage 占满）
 */
export class EventQueue {
  private readonly storage: StorageAdapter;
  private readonly maxQueueSize: number;
  private readonly maxPersistedSize: number;
  private events: AnalyticsEvent[] = [];

  constructor(opts: {
    storage: StorageAdapter;
    maxQueueSize?: number;
    maxPersistedSize?: number;
  }) {
    this.storage = opts.storage;
    this.maxQueueSize = opts.maxQueueSize && opts.maxQueueSize > 0 ? opts.maxQueueSize : 500;
    this.maxPersistedSize = opts.maxPersistedSize && opts.maxPersistedSize > 0 ? opts.maxPersistedSize : 1000;
  }

  enqueue(event: AnalyticsEvent): void {
    if (this.events.length >= this.maxQueueSize) {
      this.events.shift();
    }
    this.events.push(event);
  }

  /** 取出最多 limit 条用于上报，原地从队列移除；上报失败时由 Sender 调 returnFailed 退回 */
  take(limit: number): AnalyticsEvent[] {
    if (this.events.length === 0) return [];
    const n = Math.min(limit, this.events.length);
    return this.events.splice(0, n);
  }

  size(): number {
    return this.events.length;
  }

  /** 上报失败需要重试时把事件按原顺序退回队首 */
  returnFailed(events: AnalyticsEvent[]): void {
    if (events.length === 0) return;
    this.events.unshift(...events);
    if (this.events.length > this.maxQueueSize) {
      this.events.splice(0, this.events.length - this.maxQueueSize);
    }
  }

  /** 永久放弃的事件进死信队列，由下次启动重试一次 */
  pushDeadLetter(events: AnalyticsEvent[]): void {
    if (events.length === 0) return;
    try {
      const cached = this.storage.get(DEAD_LETTER_KEY);
      const list = (cached && safeParse<AnalyticsEvent[]>(cached)) || [];
      list.push(...events);
      while (list.length > this.maxPersistedSize) {
        list.shift();
      }
      this.storage.set(DEAD_LETTER_KEY, safeStringify(list));
    } catch (err) {
      warn('queue', 'pushDeadLetter failed', err);
    }
  }

  /** 把内存队列同步序列化到 storage，进程异常退出兜底 */
  persist(): void {
    try {
      if (this.events.length === 0) {
        if (this.storage.remove) {
          this.storage.remove(PENDING_KEY);
        } else {
          this.storage.set(PENDING_KEY, '[]');
        }
        return;
      }
      const list = this.events.length > this.maxPersistedSize
        ? this.events.slice(this.events.length - this.maxPersistedSize)
        : this.events;
      this.storage.set(PENDING_KEY, safeStringify(list));
    } catch (err) {
      warn('queue', 'persist failed', err);
    }
  }

  /** init 时调用，把 storage 里上次未发出的事件 + 死信事件并入内存队列 */
  restore(): { restored: number; deadLetterRestored: number } {
    let restored = 0;
    let deadLetterRestored = 0;
    try {
      const pending = this.storage.get(PENDING_KEY);
      if (pending) {
        const list = safeParse<AnalyticsEvent[]>(pending) || [];
        this.events.push(...list);
        restored = list.length;
        if (this.storage.remove) {
          this.storage.remove(PENDING_KEY);
        } else {
          this.storage.set(PENDING_KEY, '[]');
        }
      }
    } catch (err) {
      warn('queue', 'restore pending failed', err);
    }
    try {
      const dead = this.storage.get(DEAD_LETTER_KEY);
      if (dead) {
        const list = safeParse<AnalyticsEvent[]>(dead) || [];
        this.events.push(...list);
        deadLetterRestored = list.length;
        if (this.storage.remove) {
          this.storage.remove(DEAD_LETTER_KEY);
        } else {
          this.storage.set(DEAD_LETTER_KEY, '[]');
        }
      }
    } catch (err) {
      warn('queue', 'restore dead-letter failed', err);
    }
    if (this.events.length > this.maxQueueSize) {
      this.events.splice(0, this.events.length - this.maxQueueSize);
    }
    return { restored, deadLetterRestored };
  }
}

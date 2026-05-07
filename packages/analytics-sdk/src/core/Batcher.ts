import { warn } from './utils';

/**
 * 定时定量触发器：满足任一条件即触发 onFlush：
 * - 时间：距上次 flush 超过 flushIntervalMs
 * - 数量：当前队列长度 >= flushBulkSize
 *
 * 上报循环：
 * - notifyEnqueue：每次 track 调用都通知一次，达到 bulkSize 立即触发 flush
 * - 内部周期定时器：兜底定时 flush
 */
export class Batcher {
  private readonly flushIntervalMs: number;
  private readonly flushBulkSize: number;
  private readonly getQueueSize: () => number;
  private readonly onFlush: () => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(opts: {
    flushIntervalMs?: number;
    flushBulkSize?: number;
    getQueueSize: () => number;
    onFlush: () => Promise<void>;
  }) {
    this.flushIntervalMs = opts.flushIntervalMs && opts.flushIntervalMs > 0 ? opts.flushIntervalMs : 15000;
    this.flushBulkSize = opts.flushBulkSize && opts.flushBulkSize > 0 ? opts.flushBulkSize : 20;
    this.getQueueSize = opts.getQueueSize;
    this.onFlush = opts.onFlush;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tryFlush('interval');
    }, this.flushIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 每次 track 调用后通知，达到批量阈值立即触发 */
  notifyEnqueue(): void {
    if (this.getQueueSize() >= this.flushBulkSize) {
      void this.tryFlush('bulk');
    }
  }

  /** 外部主动触发 flush（onHide / 业务方手动 flush） */
  async flushNow(reason: string): Promise<void> {
    await this.tryFlush(reason);
  }

  private async tryFlush(reason: string): Promise<void> {
    if (this.flushing) return;
    if (this.getQueueSize() === 0) return;
    this.flushing = true;
    try {
      await this.onFlush();
    } catch (err) {
      warn('batcher', `flush failed reason=${reason}`, err);
    } finally {
      this.flushing = false;
    }
  }
}

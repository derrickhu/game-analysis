import type { TransportAdapter } from '../adapters/types';
import type { EventQueue } from './EventQueue';
import type { AnalyticsEvent } from './EventSchema';
import { debug, warn } from './utils';

const MAX_PAYLOAD_BYTES = 100 * 1024;
const MAX_RETRY = 5;
const RETRY_BASE_MS = 1000;

/**
 * 上报执行器，每次 flush 触发：
 * 1. 从 queue 取出 maxBatchSize 条
 * 2. 大小保护：序列化后 > 100KB 自动二分切片
 * 3. POST 到云函数；2xx 视为成功
 * 4. 失败按指数退避重试，最多 MAX_RETRY 次后入死信
 *
 * 注意：Transport.request 的底层兜底（wx.request 失败 fallback fetch）由调用方 PlatformService 自己保证，
 * Sender 这一层只看 statusCode，不重复管降级。
 */
export class Sender {
  private readonly transport: TransportAdapter;
  private readonly endpoint: string;
  private readonly maxBatchSize: number;

  constructor(opts: { transport: TransportAdapter; endpoint: string; maxBatchSize?: number }) {
    this.transport = opts.transport;
    this.endpoint = opts.endpoint;
    this.maxBatchSize = opts.maxBatchSize && opts.maxBatchSize > 0 ? opts.maxBatchSize : 50;
  }

  async flush(queue: EventQueue): Promise<void> {
    const batch = queue.take(this.maxBatchSize);
    if (batch.length === 0) return;

    const slices = this.splitBySize(batch);
    for (const slice of slices) {
      const ok = await this.sendWithRetry(slice);
      if (!ok) {
        queue.pushDeadLetter(slice);
      }
    }
  }

  private splitBySize(events: AnalyticsEvent[]): AnalyticsEvent[][] {
    const serialized = JSON.stringify(events);
    if (serialized.length <= MAX_PAYLOAD_BYTES || events.length <= 1) {
      return [events];
    }
    const mid = Math.floor(events.length / 2);
    return [
      ...this.splitBySize(events.slice(0, mid)),
      ...this.splitBySize(events.slice(mid)),
    ];
  }

  private async sendWithRetry(batch: AnalyticsEvent[]): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      try {
        const res = await this.transport.request({
          url: this.endpoint,
          method: 'POST',
          data: { batch },
          timeoutMs: 10000,
        });
        if (res.statusCode >= 200 && res.statusCode < 300) {
          debug('sender', `sent batch=${batch.length} attempt=${attempt + 1}`);
          return true;
        }
        // 4xx 客户端错误（请求格式不对）不再重试，直接进死信避免持续打服务端
        if (res.statusCode >= 400 && res.statusCode < 500) {
          warn('sender', `client error ${res.statusCode}, drop batch=${batch.length}`, res.data);
          return false;
        }
        warn('sender', `non-2xx ${res.statusCode} attempt=${attempt + 1}, will retry`);
      } catch (err) {
        warn('sender', `send failed attempt=${attempt + 1}`, err);
      }
      await this.sleep(RETRY_BASE_MS * Math.pow(2, attempt));
    }
    warn('sender', `give up after ${MAX_RETRY} attempts, batch=${batch.length} -> dead-letter`);
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

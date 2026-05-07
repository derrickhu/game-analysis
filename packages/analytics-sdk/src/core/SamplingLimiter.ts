/**
 * 防线 1：客户端采样 + 限流。
 * - sample(name)：按事件名查 samplingRules，命中则返回 true（保留），否则丢弃。关键事件（广告/付费/关卡）默认 1.0 全量。
 * - rateLimit(name)：单事件名每秒不超过 maxPerSecond，超出则丢尾并累计 dropped 计数，由 Analytics 周期性聚合上报 sdk_dropped 自监控事件。
 */
export class SamplingLimiter {
  private readonly samplingRules: Record<string, number>;
  private readonly maxPerSecond: number;
  private readonly windowMs = 1000;
  private buckets: Record<string, { startTs: number; count: number }> = {};
  private droppedBySampling: Record<string, number> = {};
  private droppedByRate: Record<string, number> = {};

  constructor(opts: { samplingRules: Record<string, number>; maxPerSecond: number }) {
    this.samplingRules = opts.samplingRules || {};
    this.maxPerSecond = opts.maxPerSecond > 0 ? opts.maxPerSecond : 50;
  }

  shouldKeep(eventName: string): boolean {
    const rate = this.samplingRules[eventName];
    if (rate !== undefined && rate < 1) {
      if (Math.random() >= rate) {
        this.droppedBySampling[eventName] = (this.droppedBySampling[eventName] || 0) + 1;
        return false;
      }
    }

    const ts = Date.now();
    const bucket = this.buckets[eventName];
    if (!bucket || ts - bucket.startTs >= this.windowMs) {
      this.buckets[eventName] = { startTs: ts, count: 1 };
      return true;
    }
    if (bucket.count >= this.maxPerSecond) {
      this.droppedByRate[eventName] = (this.droppedByRate[eventName] || 0) + 1;
      return false;
    }
    bucket.count += 1;
    return true;
  }

  /** 拉走累计 dropped 计数并清零；由 Analytics 周期性调用以发出 sdk_dropped 自监控事件 */
  drainDropped(): { bySampling: Record<string, number>; byRate: Record<string, number> } {
    const out = { bySampling: this.droppedBySampling, byRate: this.droppedByRate };
    this.droppedBySampling = {};
    this.droppedByRate = {};
    return out;
  }
}

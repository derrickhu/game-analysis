import type { DeviceInfo, PlatformName, StorageAdapter } from '../adapters/types';
import type { EventParamValue } from './EventSchema';
import { now, randomId } from './utils';

const ANONYMOUS_ID_KEY = '__gp_analytics_anonymous_id__';

/**
 * Context 集中管理所有"上下文"字段：anonymous_id（设备级永久 id）、session_id（单次启动）、user_id（业务登录后塞入）、
 * 以及由调用方注入的 deviceInfo / app 版本 / 平台。每条事件上报时由 Analytics 用 buildEventEnvelope 注入。
 */
export class Context {
  readonly gameKey: string;
  readonly appVersion: string;
  readonly sdkVersion: string;
  readonly platform: PlatformName;
  readonly deviceInfo: DeviceInfo;
  readonly anonymousId: string;
  readonly sessionId: string;
  readonly sessionStartTs: number;
  private userId: string;
  private sessionSeq: number;
  private readonly commonParams: Record<string, EventParamValue>;

  constructor(opts: {
    gameKey: string;
    appVersion: string;
    sdkVersion: string;
    platform: PlatformName;
    deviceInfo: DeviceInfo;
    storage: StorageAdapter;
    initialUserId?: string;
  }) {
    this.gameKey = opts.gameKey;
    this.appVersion = opts.appVersion;
    this.sdkVersion = opts.sdkVersion;
    this.platform = opts.platform;
    this.deviceInfo = opts.deviceInfo;
    this.userId = opts.initialUserId ?? '';
    this.anonymousId = Context.loadOrCreateAnonymousId(opts.storage);
    this.sessionId = randomId();
    this.sessionStartTs = now();
    this.sessionSeq = 0;
    this.commonParams = {};
  }

  setUserId(userId: string): void {
    this.userId = userId || '';
  }

  getUserId(): string {
    return this.userId;
  }

  setCommonParams(params: Record<string, EventParamValue>): void {
    for (const [key, value] of Object.entries(params)) {
      if (!key) continue;
      if (value === undefined) continue;
      this.commonParams[key] = value;
    }
  }

  clearCommonParams(keys?: string[]): void {
    if (!keys) {
      for (const key of Object.keys(this.commonParams)) {
        delete this.commonParams[key];
      }
      return;
    }
    for (const key of keys) {
      delete this.commonParams[key];
    }
  }

  getCommonParams(): Record<string, EventParamValue> {
    return { ...this.commonParams };
  }

  /** 每次 track 调用时取一个递增的会话内序号 */
  nextSessionSeq(): number {
    this.sessionSeq += 1;
    return this.sessionSeq;
  }

  /** anonymous_id 仅在首次启动生成，之后从 storage 读取，保持设备级稳定 */
  private static loadOrCreateAnonymousId(storage: StorageAdapter): string {
    try {
      const cached = storage.get(ANONYMOUS_ID_KEY);
      if (cached && cached.length >= 8) {
        return cached;
      }
    } catch {
      // 读失败按新建处理
    }
    const fresh = `anon_${randomId()}`;
    try {
      storage.set(ANONYMOUS_ID_KEY, fresh);
    } catch {
      // 写失败接受会话级临时 id（下次启动会换一个，可接受）
    }
    return fresh;
  }
}

import type {
  DeviceInfo,
  LifecycleAdapter,
  PlatformName,
  StorageAdapter,
  TransportAdapter,
} from '../adapters/types';
import { Batcher } from './Batcher';
import { Context } from './Context';
import { EventQueue } from './EventQueue';
import { DEFAULT_SAMPLING_RULES, EVENT_NAMES } from './EventSchema';
import type { AnalyticsEvent, EventParamValue } from './EventSchema';
import { SamplingLimiter } from './SamplingLimiter';
import { Sender } from './Sender';
import { debug, now, randomId } from './utils';

const SDK_VERSION = '0.1.0';

type CommonParams = Record<string, EventParamValue>;

export interface AnalyticsAdContext {
  /** 业务广告位场景，必须稳定，例：level_prop_color_blast */
  scene: string;
  /** 广告单元 ID */
  adUnitId: string;
  /** 广告类型，默认 reward */
  adType?: string;
  /** 关卡型游戏可传关卡 ID */
  levelId?: number | string;
  /** 额外业务字段，会扁平合入 params */
  extra?: CommonParams;
}

export interface AnalyticsLevelContext {
  /** 关卡 ID，统一从 1 开始 */
  levelId: number | string;
  levelName?: string;
  mode?: string;
  durationMs?: number;
  reason?: string;
  extra?: CommonParams;
}

export interface AnalyticsTutorialStepContext {
  stepId: string;
  stepIndex: number;
  status: 'done' | 'skip';
  durationMs?: number;
  isForce?: boolean;
  extra?: CommonParams;
}

export interface AnalyticsInitOptions {
  /** 上报地址，例：https://xxx.service.tcloudbase.com/track */
  endpoint: string;
  /** 游戏标识，必须在云函数白名单内 */
  gameKey: string;
  /** app 版本，建议从构建注入 */
  appVersion: string;
  /** 业务平台，未传则自动从 deviceInfo / 默认 'unknown' 推 */
  platform?: PlatformName;
  /** 设备信息，由调用方提供 */
  deviceInfo: DeviceInfo;
  /** 初始 user_id，没有可不填，登录后通过 setUserId 更新 */
  initialUserId?: string;

  transport: TransportAdapter;
  storage: StorageAdapter;
  lifecycle?: LifecycleAdapter;

  /** 批量上报间隔，默认 15000ms */
  flushIntervalMs?: number;
  /** 单批最大事件数，默认 20 */
  flushBulkSize?: number;
  /** 单次 HTTP 请求最大事件数，默认 50 */
  maxBatchSize?: number;
  /** 内存队列最大长度，默认 500 */
  maxQueueSize?: number;
  /** 持久化队列最大长度，默认 1000 */
  maxPersistedSize?: number;
  /** 单事件名每秒最大上报次数，超出丢尾，默认 50 */
  maxPerSecond?: number;
  /** 采样规则覆盖，例：{ coin_change: 0.1 } */
  samplingRules?: Record<string, number>;
  /** dropped 自监控事件上报间隔，默认 60000ms（1 分钟） */
  droppedReportIntervalMs?: number;
  /** 调试日志开关 */
  debug?: boolean;
}

class AnalyticsImpl {
  private inited = false;
  private context: Context | null = null;
  private queue: EventQueue | null = null;
  private batcher: Batcher | null = null;
  private sender: Sender | null = null;
  private limiter: SamplingLimiter | null = null;
  private droppedReportTimer: ReturnType<typeof setInterval> | null = null;
  private debugMode = false;

  init(opts: AnalyticsInitOptions): void {
    if (this.inited) {
      debug('analytics', 'already inited, skip');
      return;
    }
    if (!opts.endpoint) throw new Error('[analytics] endpoint required');
    if (!opts.gameKey) throw new Error('[analytics] gameKey required');
    if (!opts.transport) throw new Error('[analytics] transport required');
    if (!opts.storage) throw new Error('[analytics] storage required');

    this.debugMode = !!opts.debug;
    this.context = new Context({
      gameKey: opts.gameKey,
      appVersion: opts.appVersion || '0.0.0',
      sdkVersion: SDK_VERSION,
      platform: opts.platform || 'unknown',
      deviceInfo: opts.deviceInfo,
      storage: opts.storage,
      initialUserId: opts.initialUserId,
    });
    this.queue = new EventQueue({
      storage: opts.storage,
      maxQueueSize: opts.maxQueueSize,
      maxPersistedSize: opts.maxPersistedSize,
    });
    this.sender = new Sender({
      transport: opts.transport,
      endpoint: opts.endpoint,
      maxBatchSize: opts.maxBatchSize,
    });
    this.limiter = new SamplingLimiter({
      samplingRules: { ...DEFAULT_SAMPLING_RULES, ...(opts.samplingRules || {}) },
      maxPerSecond: opts.maxPerSecond ?? 50,
    });
    this.batcher = new Batcher({
      flushIntervalMs: opts.flushIntervalMs,
      flushBulkSize: opts.flushBulkSize,
      getQueueSize: () => this.queue!.size(),
      onFlush: () => this.sender!.flush(this.queue!),
    });

    const restored = this.queue.restore();
    if (this.debugMode && (restored.restored || restored.deadLetterRestored)) {
      debug(
        'analytics',
        `restored pending=${restored.restored}, dead-letter=${restored.deadLetterRestored}`,
      );
    }
    this.batcher.start();

    if (opts.lifecycle?.onHide) {
      opts.lifecycle.onHide(() => {
        this.queue?.persist();
        void this.batcher?.flushNow('lifecycle-hide');
      });
    }

    const droppedInterval = opts.droppedReportIntervalMs && opts.droppedReportIntervalMs > 0
      ? opts.droppedReportIntervalMs
      : 60000;
    this.droppedReportTimer = setInterval(() => {
      this.reportDroppedIfAny();
    }, droppedInterval);

    this.inited = true;
    debug('analytics', `inited gameKey=${opts.gameKey} sdk=${SDK_VERSION} endpoint=${opts.endpoint}`);
  }

  /**
   * 业务登录后调用，让后续所有事件都自动带 user_id。
   *
   * 默认行为（与"登录就上报"用户预期对齐）：
   * - 同一会话内 user_id 第一次从空变成有值时，自动 track 一次 LOGIN 事件（带 from_anonymous=true），
   *   后端可以基于这条事件把 anonymous_id ↔ user_id 做归一映射，避免双计数 DAU
   * - 立即 flush 当前队列，不等下一次 batch（默认 15s 间隔），让登录后的关键事件最快上报
   *
   * 调用方可以传 opts 关闭这两个默认行为；hot-pot 默认就用默认值即可。
   */
  setUserId(userId: string, opts?: { trackLogin?: boolean; flushImmediately?: boolean }): void {
    if (!this.context) return;
    const before = this.context.getUserId();
    this.context.setUserId(userId);
    const becameLoggedIn = !!userId && !before;
    if (becameLoggedIn && opts?.trackLogin !== false) {
      // LOGIN 事件用「设完之后」的 user_id 入队（buildEnvelope 会读最新 ctx.getUserId）
      this.track(EVENT_NAMES.LOGIN, { from_anonymous: true });
    }
    if (userId && opts?.flushImmediately !== false) {
      // 立即 flush 已经入队的所有事件（包括上面这条 LOGIN，以及 setUserId 之前积压的 anonymous 事件）
      void this.batcher?.flushNow('set-user-id');
    }
  }

  track(eventName: string, params: Record<string, EventParamValue> = {}): void {
    if (!this.inited || !this.context || !this.queue || !this.limiter || !this.batcher) {
      // 未初始化时丢弃，避免业务接入顺序错带来的隐式异常
      return;
    }
    if (!eventName) return;
    if (!this.limiter.shouldKeep(eventName)) return;

    const envelope = this.buildEnvelope(eventName, params);
    this.queue.enqueue(envelope);
    this.batcher.notifyEnqueue();

    if (this.debugMode) {
      debug('analytics', `track ${eventName}`, params);
    }
  }

  /**
   * 设置所有后续事件都会自动携带的公共参数。
   *
   * 典型用途：广告归因上下文（campaign/adgroup/creative/click_id）、
   * A/B 实验分组、灰度渠道等。单条 track 传入的同名参数优先级更高。
   */
  setCommonParams(params: CommonParams): void {
    if (!this.context) return;
    this.context.setCommonParams(params);
  }

  /** 清除公共参数；不传 keys 时清空全部。 */
  clearCommonParams(keys?: string[]): void {
    if (!this.context) return;
    this.context.clearCommonParams(keys);
  }

  trackSessionStart(params: CommonParams = {}): void {
    this.track(EVENT_NAMES.SESSION_START, params);
  }

  trackSessionEnd(reason: string, params: CommonParams = {}): void {
    this.track(EVENT_NAMES.SESSION_END, { ...params, reason });
  }

  trackAppShow(params: CommonParams = {}): void {
    this.track(EVENT_NAMES.APP_SHOW, params);
  }

  trackAppError(err: unknown, params: CommonParams = {}): void {
    const message = err instanceof Error ? err.message : String(err || 'unknown');
    const stack = err instanceof Error ? String(err.stack || '').slice(0, 800) : '';
    this.track(EVENT_NAMES.APP_ERROR, {
      ...params,
      err_code: params.err_code ?? 'client_error',
      err_msg: message.slice(0, 240),
      stack,
    });
  }

  trackLevelStart(context: AnalyticsLevelContext): void {
    this.track(EVENT_NAMES.LEVEL_START, this.buildLevelParams(context));
  }

  trackLevelClear(context: AnalyticsLevelContext): void {
    this.track(EVENT_NAMES.LEVEL_CLEAR, this.buildLevelParams(context));
  }

  trackLevelFail(context: AnalyticsLevelContext): void {
    this.track(EVENT_NAMES.LEVEL_FAIL, this.buildLevelParams(context));
  }

  trackTutorialStep(context: AnalyticsTutorialStepContext): void {
    this.track(EVENT_NAMES.TUTORIAL_STEP, {
      step_id: context.stepId,
      step_index: context.stepIndex,
      status: context.status,
      ...(context.durationMs !== undefined ? { duration_ms: context.durationMs } : {}),
      ...(context.isForce !== undefined ? { is_force: context.isForce } : {}),
      ...(context.extra || {}),
    });
  }

  trackShareAppMessage(
    entryPoint: string,
    params: { title?: string; imageUrl?: string; query?: string; extra?: CommonParams } = {},
  ): void {
    this.track(EVENT_NAMES.SHARE_APP_MESSAGE, {
      entry_point: entryPoint,
      ...(params.title ? { title: params.title } : {}),
      ...(params.imageUrl ? { image_url: params.imageUrl } : {}),
      ...(params.query ? { query: params.query } : {}),
      ...(params.extra || {}),
    });
  }

  trackShareTimeline(
    entryPoint: string,
    params: { title?: string; imageUrl?: string; query?: string; extra?: CommonParams } = {},
  ): void {
    this.track(EVENT_NAMES.SHARE_TIMELINE, {
      entry_point: entryPoint,
      ...(params.title ? { title: params.title } : {}),
      ...(params.imageUrl ? { image_url: params.imageUrl } : {}),
      ...(params.query ? { query: params.query } : {}),
      ...(params.extra || {}),
    });
  }

  trackAdRequest(context: AnalyticsAdContext): void {
    this.track(EVENT_NAMES.AD_REQUEST, this.buildAdParams(context));
  }

  trackAdShow(context: AnalyticsAdContext): void {
    this.track(EVENT_NAMES.AD_SHOW, this.buildAdParams(context));
  }

  trackAdClose(context: AnalyticsAdContext, params: CommonParams = {}): void {
    this.track(EVENT_NAMES.AD_CLOSE, this.buildAdParams(context, params));
  }

  trackAdError(context: AnalyticsAdContext, params: { errCode: number | string; errMsg: string } & CommonParams): void {
    const { errCode, errMsg, ...rest } = params;
    this.track(EVENT_NAMES.AD_ERROR, this.buildAdParams(context, {
      ...rest,
      err_code: errCode,
      err_msg: errMsg || 'unknown',
    }));
  }

  /** 业务方主动 flush（一般无需调用，onHide 已自动 flush） */
  async flush(reason = 'manual'): Promise<void> {
    await this.batcher?.flushNow(reason);
  }

  /** 销毁 SDK：停止定时器、持久化未发出的事件。一般测试用 */
  destroy(): void {
    this.batcher?.stop();
    if (this.droppedReportTimer) {
      clearInterval(this.droppedReportTimer);
      this.droppedReportTimer = null;
    }
    this.queue?.persist();
    this.inited = false;
  }

  private buildEnvelope(eventName: string, params: Record<string, EventParamValue>): AnalyticsEvent {
    const ctx = this.context!;
    const mergedParams = {
      ...ctx.getCommonParams(),
      ...(params || {}),
    };
    return {
      event_id: randomId(),
      event_name: eventName,
      event_ts: now(),
      game_key: ctx.gameKey,
      app_version: ctx.appVersion,
      sdk_version: ctx.sdkVersion,
      platform: ctx.platform,
      user_id: ctx.getUserId(),
      anonymous_id: ctx.anonymousId,
      session_id: ctx.sessionId,
      session_seq: ctx.nextSessionSeq(),
      device: {
        brand: ctx.deviceInfo.brand,
        model: ctx.deviceInfo.model,
        system: ctx.deviceInfo.system,
        sdk_version: ctx.deviceInfo.sdkVersion,
        screen_w: ctx.deviceInfo.screenWidth,
        screen_h: ctx.deviceInfo.screenHeight,
        network: ctx.deviceInfo.network || 'unknown',
      },
      params: mergedParams,
    };
  }

  private buildLevelParams(context: AnalyticsLevelContext): CommonParams {
    return {
      level_id: context.levelId,
      ...(context.levelName ? { level_name: context.levelName } : {}),
      ...(context.mode ? { mode: context.mode } : {}),
      ...(context.durationMs !== undefined ? { duration_ms: context.durationMs } : {}),
      ...(context.reason ? { reason: context.reason } : {}),
      ...(context.extra || {}),
    };
  }

  private buildAdParams(context: AnalyticsAdContext, extras: CommonParams = {}): CommonParams {
    return {
      ad_unit_id: context.adUnitId,
      ad_type: context.adType || 'reward',
      scene: context.scene || 'unknown',
      ...(context.levelId !== undefined && context.levelId !== null ? { level_id: context.levelId } : {}),
      ...(context.extra || {}),
      ...extras,
    };
  }

  private reportDroppedIfAny(): void {
    if (!this.limiter) return;
    const drained = this.limiter.drainDropped();
    const samplingTotal = Object.values(drained.bySampling).reduce((s, n) => s + n, 0);
    const rateTotal = Object.values(drained.byRate).reduce((s, n) => s + n, 0);
    if (samplingTotal === 0 && rateTotal === 0) return;
    this.track(EVENT_NAMES.SDK_DROPPED, {
      sampling_total: samplingTotal,
      rate_total: rateTotal,
      details: JSON.stringify({ sampling: drained.bySampling, rate: drained.byRate }),
    });
  }
}

/** SDK 单例，所有业务调用都通过这一个对象 */
export const Analytics = new AnalyticsImpl();

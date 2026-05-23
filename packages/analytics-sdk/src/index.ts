/**
 * @gp/analytics-sdk
 *
 * 标准化游戏经分埋点 SDK。零运行时依赖，跨平台（微信/抖音小游戏 / H5 / 引擎桥）通用。
 *
 * 用法：
 *   import { Analytics, EVENT_NAMES } from '@gp/analytics-sdk';
 *   Analytics.init({ endpoint, gameKey, appVersion, deviceInfo, transport, storage, lifecycle });
 *   Analytics.track(EVENT_NAMES.AD_SHOW, { ad_unit_id: '...', scene: 'level_fail_revive' });
 */
export { Analytics } from './core/Analytics';
export type {
  AnalyticsAdContext,
  AnalyticsInitOptions,
  AnalyticsLevelContext,
  AnalyticsTutorialStepContext,
} from './core/Analytics';
export { EVENT_NAMES, DEFAULT_SAMPLING_RULES } from './core/EventSchema';
export type { AnalyticsEvent, EventParamValue } from './core/EventSchema';
export type {
  TransportAdapter,
  StorageAdapter,
  LifecycleAdapter,
  DeviceInfo,
  PlatformName,
} from './adapters/types';

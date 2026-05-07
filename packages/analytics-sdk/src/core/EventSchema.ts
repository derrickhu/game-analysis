import type { PlatformName } from '../adapters/types';

/**
 * 标准化事件结构，所有游戏共用，新增字段必须保持向后兼容（旧客户端老 SDK 仍能上报）。
 * 参考 GA4 / 神策 / Firebase Analytics 的事件模型设计。
 */
export interface AnalyticsEvent {
  /** SDK 生成的随机 id，服务端按此去重幂等（同一 event_id 多次上报视为同一事件） */
  event_id: string;
  /** 事件名，snake_case，业务自定义但建议使用下方 EVENT_NAMES 中的常量 */
  event_name: string;
  /** 客户端事件发生时间，毫秒 */
  event_ts: number;
  /** 服务端入库时间（云函数补） */
  ingest_ts?: number;
  /** 游戏标识，例：'hotpot' / 'huahua' / 'caizhu' */
  game_key: string;
  /** 业务侧的 app 版本，便于按版本筛选 */
  app_version: string;
  /** SDK 版本，便于排查上报兼容性 */
  sdk_version: string;
  /** 平台标识 */
  platform: PlatformName;
  /** openid 等业务用户 id，未登录时空串 */
  user_id: string;
  /** 设备级永久匿名 id，首次启动生成存 storage */
  anonymous_id: string;
  /** 单次启动会话 id */
  session_id: string;
  /** 会话内事件递增序号，便于排序和补漏检测 */
  session_seq: number;
  /** 设备信息，由 SDK init 时注入 */
  device: {
    brand: string;
    model: string;
    system: string;
    sdk_version: string;
    screen_w: number;
    screen_h: number;
    network: string;
  };
  /** 事件级业务字段，扁平化键值对，避免嵌套对象 */
  params: Record<string, EventParamValue>;
}

/** 事件参数允许的值类型，限制为基础类型避免后端聚合复杂度 */
export type EventParamValue = string | number | boolean | null;

/**
 * MVP 阶段标准事件名清单，使用常量避免拼写错误，业务方可以传任意自定义名（不限制白名单）。
 * 命名规范：动词 + 对象，全 snake_case。
 */
export const EVENT_NAMES = {
  // 通用生命周期
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
  /** 业务侧拿到 user_id（通常 = openid）后自动上报，给后端做 anonymous_id ↔ user_id 归一锚点 */
  LOGIN: 'login',
  APP_ERROR: 'app_error',

  // 关卡
  LEVEL_START: 'level_start',
  LEVEL_CLEAR: 'level_clear',
  LEVEL_FAIL: 'level_fail',

  // 广告（核心：广告收益估算的数据来源）
  AD_REQUEST: 'ad_request',
  AD_SHOW: 'ad_show',
  AD_CLICK: 'ad_click',
  AD_CLOSE: 'ad_close',
  AD_ERROR: 'ad_error',

  // 经济
  COIN_CHANGE: 'coin_change',
  DIAMOND_CHANGE: 'diamond_change',

  // SDK 自身指标，用于反向监控上报系统健康度
  SDK_DROPPED: 'sdk_dropped',
} as const;

/**
 * 默认采样配置：关键事件 100% 全量，高频普通事件降采样。
 * 业务方可以在 init 时通过 samplingRules 覆盖。
 */
export const DEFAULT_SAMPLING_RULES: Record<string, number> = {
  [EVENT_NAMES.COIN_CHANGE]: 0.1,
  [EVENT_NAMES.DIAMOND_CHANGE]: 0.1,
};

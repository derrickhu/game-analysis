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
  /**
   * 业务侧拿到 user_id（通常 = openid）后由 SDK setUserId 自动触发，给后端做 anonymous_id ↔ user_id
   * 归一锚点；业务**不要**手工 track。
   */
  LOGIN: 'login',
  /**
   * app 切前台。**业务可选打**，主要用来观察"切后台再回来"的留存形态；
   * SDK 不会自动打，也**不会**因 app_show 重置 session_id（session = 一次冷启动）。
   */
  APP_SHOW: 'app_show',
  APP_ERROR: 'app_error',
  /** 启动 / 回流来源触点，承载 launch query、referrer 和广告点击标识 */
  ATTRIBUTION_TOUCHPOINT: 'attribution_touchpoint',
  /** 客户端或服务端解析出的归因结果，最终以服务端 user_attribution 为准 */
  ATTRIBUTION_RESOLVED: 'attribution_resolved',

  // 分享（只代表发起分享，不代表分享成功或带来回流）
  /** 转发给好友 / 群（微信 onShareAppMessage / wx.shareAppMessage / 抖音 tt.shareAppMessage） */
  SHARE_APP_MESSAGE: 'share_app_message',
  /** 朋友圈分享（仅微信 onShareTimeline；抖音无对等通道） */
  SHARE_TIMELINE: 'share_timeline',

  // 关卡（有"关卡 / 闯关"概念的游戏接，例如 hot-pot）
  LEVEL_START: 'level_start',
  LEVEL_CLEAR: 'level_clear',
  LEVEL_FAIL: 'level_fail',

  // 进度 / 任务（无关卡型游戏使用，例如花花的合成经营、签到、活动任务）
  /** 任务 / 关卡进度开始：玩家接受任务、进入活动、开始挑战时打 */
  QUEST_START: 'quest_start',
  /** 任务完成：领奖时打（不是显示完成 UI 时） */
  QUEST_COMPLETE: 'quest_complete',
  /** 任务放弃 / 主动取消（区别于失败：玩家行为而非系统判定） */
  QUEST_ABANDON: 'quest_abandon',

  // 新手引导漏斗（每个游戏建议都接，否则无法分析新手流失）
  /** 教学步骤完成或跳过；用 step_id 串成漏斗 */
  TUTORIAL_STEP: 'tutorial_step',

  // 合成经营类玩法事件（花花、未来彩珠等合成游戏共用，非该类游戏不必接）
  /** 棋盘合成成功：合成两个同等级物品产生新等级物品 */
  MERGE_SUCCESS: 'merge_success',
  /** 订单生成：客人到店要求 N 件货物 */
  ORDER_SPAWN: 'order_spawn',
  /** 订单交付：玩家把客人要的物品送出，结算花愿/钻石 */
  ORDER_DELIVER: 'order_deliver',
  /** 限时订单超时：玩家没在时限内交付 */
  ORDER_EXPIRE: 'order_expire',
  /** 订单撕单 / 客人主动放弃 */
  ORDER_DITCH: 'order_ditch',
  /** 装饰花愿购买（房间风格 / 家具 / 摆件） */
  DECORATION_PURCHASE: 'decoration_purchase',
  /** 换装解锁（皮肤 / 衣服 / 装扮） */
  DRESSUP_UNLOCK: 'dressup_unlock',
  /** 全局星级提升（合成经营游戏的成长锚点） */
  STAR_LEVEL_UP: 'star_level_up',

  // 留存玩法事件（每日任务、签到、抽卡、熟客卡）
  /** 单条日常任务领奖 */
  DAILY_QUEST_CLAIM: 'daily_quest_claim',
  /** 周积分里程碑领奖 */
  WEEKLY_MILESTONE_CLAIM: 'weekly_milestone_claim',
  /** 每日签到 */
  CHECKIN_SIGN: 'checkin_sign',
  /** 抽奖喷泉抽奖（单抽 / 十连 / 广告免费十连） */
  FOUNTAIN_DRAW: 'fountain_draw',
  /** 熟客卡掉落（按客人交付次数随机产出） */
  AFFINITY_CARD_DROP: 'affinity_card_drop',
  /** 图鉴新发现（首次合成出某物品 / 首次完成订单等） */
  COLLECTION_DISCOVER: 'collection_discover',
  /** 离线收益领取 */
  IDLE_REWARD_CLAIM: 'idle_reward_claim',
  /** 体力购买（钻石换体力） */
  STAMINA_BUY: 'stamina_buy',
  /** 体力广告恢复 */
  STAMINA_AD_RECOVER: 'stamina_ad_recover',

  // 广告（核心：广告收益估算的数据来源）
  AD_REQUEST: 'ad_request',
  AD_SHOW: 'ad_show',
  AD_CLICK: 'ad_click',
  AD_CLOSE: 'ad_close',
  AD_ERROR: 'ad_error',

  // 经济（业务自定义货币如体力、票券，沿用相同语义自起 `xxx_change` 事件名）
  COIN_CHANGE: 'coin_change',
  DIAMOND_CHANGE: 'diamond_change',

  // 付费（Phase 2，先把命名占住，避免后续接入散打）
  /** 用户点击付费按钮，弹起平台支付弹窗时打 */
  PURCHASE_INITIATE: 'purchase_initiate',
  /** 平台返回付费成功（微信 wx.requestMidasPayment success / 抖音同名 API success） */
  PURCHASE_COMPLETE: 'purchase_complete',
  /** 平台返回付费失败 / 取消 / 异常 */
  PURCHASE_FAIL: 'purchase_fail',

  // SDK 自身指标，用于反向监控上报系统健康度
  SDK_DROPPED: 'sdk_dropped',
} as const;

/**
 * 默认采样配置：关键事件 100% 全量，高频普通事件降采样。
 * 业务方可以在 init 时通过 samplingRules 覆盖（同样适用于业务自起的 *_change 事件名）。
 */
export const DEFAULT_SAMPLING_RULES: Record<string, number> = {
  [EVENT_NAMES.COIN_CHANGE]: 0.1,
  [EVENT_NAMES.DIAMOND_CHANGE]: 0.1,
  // 合成是花花的核心高频行为（玩 1 小时可触发上千次），降到 10% 既能看趋势又不爆配额
  [EVENT_NAMES.MERGE_SUCCESS]: 0.1,
};

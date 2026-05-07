/**
 * SDK 不直接依赖任何宿主平台 API（wx/tt/document 等），所有平台调用走这里声明的三个 Adapter 接口，
 * 由调用方在 init 时注入；这样同一份 SDK 可以同时支持微信小游戏、抖音小游戏、H5、Cocos、Unity 桥等。
 */

/** HTTP 传输适配器：屏蔽 wx.request / tt.request / fetch 的差异 */
export interface TransportAdapter {
  request(opts: {
    url: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    data?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ statusCode: number; data: unknown }>;
}

/** 持久化适配器：用于 anonymous_id 持久化、离线兜底队列等 */
export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove?(key: string): void;
}

/** 生命周期适配器：用于 onHide 时立刻 flush + 持久化 */
export interface LifecycleAdapter {
  onHide(handler: () => void): void;
  onShow?(handler: () => void): void;
}

/** 设备信息（init 时一次性传入即可，SDK 不主动调任何系统 API） */
export interface DeviceInfo {
  brand: string;
  model: string;
  system: string;
  sdkVersion: string;
  screenWidth: number;
  screenHeight: number;
  network?: string;
}

/** 平台标识 */
export type PlatformName = 'wechat' | 'douyin' | 'h5' | 'unknown';

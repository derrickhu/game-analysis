/**
 * 经分后端"事件流拉取"配置。名单不再手写第二份，统一跟 shared/games.ts 的 ALL_GAMES：
 * - hasAnalyticsSdk=true → enabled，cron 拉事件，首页出卡片
 * - hasAnalyticsSdk=false → 只登记、不拉、不上首页
 *
 * 新游戏标准化接入：
 *   1. ALL_GAMES 加一行，hasAnalyticsSdk 翻 true
 *   2. ecpm.ts 加该游戏的 ECPM
 *   3. 云函数 ANALYTICS_GAME_KEYS 加该 game_key
 *   4. 重启经分 API（./start.sh restart）
 */

import { ALL_GAMES } from '../../shared/games';

export interface AnalyticsGameConfig {
  gameKey: string;
  displayName: string;
  /** CloudBase 环境 ID，多款游戏目前共用一个 env */
  cloudEnv: string;
  /** 是否已经接入 SDK 在产数据。false 时 cron 跳过该游戏，节省配额、保持 dashboard 干净 */
  enabled: boolean;
}

export const ANALYTICS_EVENTS_COLLECTION = 'analytics_events';

const DEFAULT_CLOUD_ENV = process.env.TCB_ENV || 'rosa-env-d7grf78r5dbd37323';

export const ANALYTICS_GAMES: AnalyticsGameConfig[] = ALL_GAMES.map((g) => ({
  gameKey: g.gameKey,
  displayName: g.displayName,
  cloudEnv: DEFAULT_CLOUD_ENV,
  enabled: g.hasAnalyticsSdk,
}));

export function getAnalyticsGameKeys(): string[] {
  return ANALYTICS_GAMES.map((g) => g.gameKey);
}

export function getEnabledAnalyticsGames(): AnalyticsGameConfig[] {
  return ANALYTICS_GAMES.filter((g) => g.enabled);
}

export function findAnalyticsGame(gameKey: string): AnalyticsGameConfig | undefined {
  return ANALYTICS_GAMES.find((g) => g.gameKey === gameKey);
}

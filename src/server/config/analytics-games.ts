/**
 * 经分后端"事件流拉取"配置。与现有 GAME_CONFIGS（存档差分流）解耦：
 * - GAME_CONFIGS 是按游戏拉各自的 *_playerData 快照集合
 * - ANALYTICS_GAMES 是从一个共用的 analytics_events 集合按 game_key 字段过滤拉新事件
 *
 * 新增一款游戏接入只需要：
 *   1. 在下面 ANALYTICS_GAMES 加一行，并把 enabled 设为 true
 *   2. 在 ecpm.ts 加该游戏的 ECPM 配置
 *   3. 云函数 ANALYTICS_GAME_KEYS 环境变量加该 game_key
 *
 * enabled 字段用于「按接入与否决定是否拉取」：
 * - true: cron 每 30s 拉一次该游戏的事件
 * - false: 完全跳过该游戏（不浪费 CloudBase API 调用次数，也不污染拉取记录）
 *   未接入 SDK 的游戏放这里也行，等真正接入时再翻开关
 */

export interface AnalyticsGameConfig {
  gameKey: string;
  displayName: string;
  /** CloudBase 环境 ID，多款游戏目前共用一个 env */
  cloudEnv: string;
  /** 是否已经接入 SDK 在产数据。false 时 cron 跳过该游戏，节省配额、保持 dashboard 干净 */
  enabled: boolean;
}

export const ANALYTICS_EVENTS_COLLECTION = 'analytics_events';

export const ANALYTICS_GAMES: AnalyticsGameConfig[] = [
  {
    gameKey: 'hotpot',
    displayName: '别捞水果',
    cloudEnv: process.env.TCB_ENV || 'rosa-env-d7grf78r5dbd37323',
    enabled: true,
  },
  {
    gameKey: 'huahua',
    displayName: '花花妙屋',
    cloudEnv: process.env.TCB_ENV || 'rosa-env-d7grf78r5dbd37323',
    enabled: true,
  },
  {
    gameKey: 'caizhu',
    displayName: '彩珠五连',
    cloudEnv: process.env.TCB_ENV || 'rosa-env-d7grf78r5dbd37323',
    enabled: true,
  },
  {
    gameKey: 'petTower',
    displayName: '灵宠消消塔2',
    cloudEnv: process.env.TCB_ENV || 'rosa-env-d7grf78r5dbd37323',
    enabled: true,
  },
  {
    gameKey: 'xiaochu',
    displayName: '灵宠消消塔',
    cloudEnv: process.env.TCB_ENV || 'rosa-env-d7grf78r5dbd37323',
    enabled: true,
  },
];

export function getAnalyticsGameKeys(): string[] {
  return ANALYTICS_GAMES.map((g) => g.gameKey);
}

export function getEnabledAnalyticsGames(): AnalyticsGameConfig[] {
  return ANALYTICS_GAMES.filter((g) => g.enabled);
}

export function findAnalyticsGame(gameKey: string): AnalyticsGameConfig | undefined {
  return ANALYTICS_GAMES.find((g) => g.gameKey === gameKey);
}

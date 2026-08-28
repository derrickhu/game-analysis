/**
 * 预估 eCPM 配置表，按 (game_key, ad_type, scene) 三级查找逐级回退到默认值。
 * 单位：人民币元 / 千次曝光（千次有效广告展示的预估收益，不是真实结算数据）。
 *
 * 数据来源：基于历史结算回看 + 同行业平均水平人工维护，每月人工 review 一次校准。
 * Phase 2 接入流量主结算 API 后，可改为定期自动校准。
 *
 * Dashboard 上展示金额时必须显式标注"估算值"，避免被业务方误读为真实收入。
 */

const ECPM_TABLE: Record<string, number> = {
  // hotpot
  'hotpot.reward.level_fail_revive': 35,
  'hotpot.reward.daily_bonus': 28,
  'hotpot.interstitial.level_clear': 12,
  'hotpot.reward': 30,
  'hotpot.interstitial': 12,
  'hotpot._default': 20,

  // huahua
  'huahua.reward.daily_bonus': 30,
  'huahua.reward.merge_double': 32,
  'huahua.interstitial.level_clear': 10,
  'huahua.reward': 28,
  'huahua.interstitial': 10,
  'huahua._default': 18,

  // caizhu
  'caizhu.reward.level_prop_colorBlast': 24,
  'caizhu.reward.level_prop_crossClear': 24,
  'caizhu.reward.level_prop_wildNext': 24,
  'caizhu.custom.classic_native_template': 8,
  'caizhu.reward.daily_bonus': 26,
  'caizhu.interstitial.level_clear': 9,
  'caizhu.reward': 24,
  'caizhu.custom': 8,
  'caizhu.interstitial': 9,
  'caizhu._default': 15,

  // petTower（灵宠消消塔2）
  'petTower.reward': 24,
  'petTower._default': 15,

  // cunkou（村口大战外星人）
  'cunkou.reward.revive': 28,
  'cunkou.reward.settleDouble': 26,
  'cunkou.reward.dailyGift': 24,
  'cunkou.reward.junkyard': 24,
  'cunkou.reward': 25,
  'cunkou._default': 15,

  // wujin_wenzhang（无尽纹章）
  'wujin_wenzhang.reward.revive': 28,
  'wujin_wenzhang.reward.shopRefresh': 24,
  'wujin_wenzhang.reward.freeUnit': 24,
  'wujin_wenzhang.reward.doubleStar': 26,
  'wujin_wenzhang.reward.dailyFreeRoll': 24,
  'wujin_wenzhang.reward': 25,
  'wujin_wenzhang._default': 15,

  // xiaochu
  'xiaochu.reward.staminaRecovery': 24,
  'xiaochu.reward.signDouble': 24,
  'xiaochu.reward.dailyTaskBonus': 24,
  'xiaochu.reward.newbieFirstClearDouble': 26,
  'xiaochu.reward.settleDouble': 26,
  'xiaochu.reward.revive': 28,
  'xiaochu.reward': 25,
  'xiaochu._default': 15,

  // 全局兜底
  '_default.reward': 25,
  '_default.interstitial': 10,
  '_default': 15,
};

/**
 * 三级回退查找：(game.adType.scene) → (game.adType) → (game._default) → (_default.adType) → (_default)
 * 任何级别命中即返回。
 */
export function getEstimatedEcpm(gameKey: string, adType: string, scene: string): number {
  const candidates = [
    `${gameKey}.${adType}.${scene}`,
    `${gameKey}.${adType}`,
    `${gameKey}._default`,
    `_default.${adType}`,
    '_default',
  ];
  for (const key of candidates) {
    const v = ECPM_TABLE[key];
    if (typeof v === 'number' && v > 0) return v;
  }
  return 15;
}

/** 由 ad_show_count 估算收益（人民币元）：count / 1000 * ecpm */
export function estimateRevenueCny(adShowCount: number, ecpm: number): number {
  if (adShowCount <= 0 || ecpm <= 0) return 0;
  return Math.round((adShowCount / 1000) * ecpm * 100) / 100;
}

export interface TencentAdsDryRunInput {
  gameKey: string;
  userKey: string;
  userId: string;
  anonymousId: string;
  eventName: string;
  eventTs: number;
  provider: string;
  campaignId: string;
  adgroupId: string;
  creativeId: string;
  clickId: string;
  gdtVid: string;
}

const EVENT_NAME_MAP: Record<string, string> = {
  first_open: 'ACTIVATE_APP',
  tutorial_complete: 'COMPLETE_TUTORIAL',
  first_order_deliver: 'CUSTOM_FIRST_ORDER_DELIVER',
  first_ad_show: 'CUSTOM_FIRST_AD_SHOW',
  d1_retained: 'CUSTOM_D1_RETAINED',
  d3_retained: 'CUSTOM_D3_RETAINED',
  estimated_ltv_bucket: 'CUSTOM_ESTIMATED_LTV_BUCKET',
};

/**
 * 腾讯广告回传 dry-run payload。
 *
 * 这里不调用平台接口，只把内部事件映射成未来 adapter 会发送的标准结构，
 * 便于上线前核对 click 标识、openid/userId、转化事件名和幂等键。
 */
export function buildTencentAdsDryRunPayload(input: TencentAdsDryRunInput): {
  platformEventName: string;
  payload: Record<string, unknown>;
} {
  const platformEventName = EVENT_NAME_MAP[input.eventName] || `CUSTOM_${input.eventName.toUpperCase()}`;
  return {
    platformEventName,
    payload: {
      action_type: platformEventName,
      action_time: Math.floor(input.eventTs / 1000),
      game_key: input.gameKey,
      user_key: input.userKey,
      user_id: input.userId,
      anonymous_id: input.anonymousId,
      campaign_id: input.campaignId,
      adgroup_id: input.adgroupId,
      creative_id: input.creativeId,
      click_id: input.clickId,
      gdt_vid: input.gdtVid,
      provider: input.provider,
      dry_run: true,
    },
  };
}

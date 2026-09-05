import { readBoolean, readPublisherGameMappings, type PublisherGameMapping } from '../env';

export type WechatPublisherGameMapping = PublisherGameMapping;

export interface WechatPublisherConfig {
  enabled: boolean;
  gameMappings: WechatPublisherGameMapping[];
}

export function getWechatPublisherConfig(): WechatPublisherConfig {
  return {
    enabled: readBoolean('WECHAT_PUBLISHER_ENABLED'),
    gameMappings: readPublisherGameMappings('WECHAT_PUBLISHER_GAME_MAPPINGS_JSON', '微信流量主'),
  };
}

import { readBoolean, readPublisherGameMappings, type PublisherGameMapping } from '../env';

export type DouyinPublisherGameMapping = PublisherGameMapping;

export interface DouyinPublisherConfig {
  enabled: boolean;
  gameMappings: DouyinPublisherGameMapping[];
}

export function getDouyinPublisherConfig(): DouyinPublisherConfig {
  return {
    enabled: readBoolean('DOUYIN_PUBLISHER_ENABLED'),
    gameMappings: readPublisherGameMappings('DOUYIN_PUBLISHER_GAME_MAPPINGS_JSON', '抖音流量主'),
  };
}

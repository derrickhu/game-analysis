import type { PlayerFacts, RawSnapshot } from '../../shared/types';
import { parseHotpotSnapshot } from './hotpot';
import { parseHuahuaSnapshot } from './huahua';

export interface GameSnapshotAdapter {
  gameKey: string;
  parseSnapshot(snapshot: RawSnapshot): PlayerFacts;
}

const adapters = new Map<string, GameSnapshotAdapter>([
  ['huahua', { gameKey: 'huahua', parseSnapshot: parseHuahuaSnapshot }],
  ['hotpot', { gameKey: 'hotpot', parseSnapshot: parseHotpotSnapshot }],
]);

export function getSnapshotAdapter(gameKey: string): GameSnapshotAdapter {
  return adapters.get(gameKey) ?? adapters.get('huahua')!;
}

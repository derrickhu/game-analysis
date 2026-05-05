import type { RawSnapshot } from '../../shared/types';

function asPayloadKeys(raw: any): string[] {
  if (Array.isArray(raw.payloadKeys)) return raw.payloadKeys.map(String);
  if (raw.payload && typeof raw.payload === 'object') return Object.keys(raw.payload);
  return [];
}

export function normalizeSnapshotDoc(
  doc: any,
  gameKey: string,
  collectionName: string,
): RawSnapshot {
  const payload = doc.payload && typeof doc.payload === 'object' ? doc.payload : {};

  return {
    gameKey,
    collectionName,
    docId: String(doc._id ?? doc.id ?? doc.docId ?? doc.userId),
    userId: String(doc.userId ?? ''),
    platform: String(doc.platform ?? 'unknown'),
    schemaVersion: Number(doc.schemaVersion || 0),
    updatedAt: Number(doc.updatedAt || 0),
    lastWriteAt: Number(doc.lastWriteAt || doc.updatedAt || 0),
    payloadKeys: asPayloadKeys(doc),
    payload,
    importedAt: Date.now(),
  };
}

import fs from 'node:fs';
import path from 'node:path';

import { getConfig } from '../config';
import { upsertRawSnapshot } from '../db';
import { normalizeSnapshotDoc } from '../importers/snapshot-normalizer';
import { recomputeDailyMetrics } from '../metrics';

function readArg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const config = getConfig();
const gameKey = readArg('game', config.defaultGameKey);
const filePath = readArg('file');
const collectionName = readArg('collection', `${gameKey}_playerData`);

if (!filePath) {
  throw new Error('缺少 --file=xxx.json 参数');
}

const absolutePath = path.resolve(filePath);
const raw = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
const docs = Array.isArray(raw) ? raw : raw.data;

if (!Array.isArray(docs)) {
  throw new Error('导入文件必须是数组，或包含 data 数组');
}

for (const doc of docs) {
  upsertRawSnapshot(normalizeSnapshotDoc(doc, gameKey, collectionName));
}

const metrics = recomputeDailyMetrics(gameKey);
console.log(`导入完成: game=${gameKey}, snapshots=${docs.length}, metricDays=${metrics.length}`);

import tcb from '@cloudbase/node-sdk';

import { createIngestRun, finishIngestRun, upsertRawSnapshot, upsertSnapshotHistory } from './db';
import { normalizeSnapshotDoc } from './importers/snapshot-normalizer';
import { recomputeDailyMetrics, recomputeHourlyMetrics } from './metrics';

export interface CloudbaseIngestOptions {
  env: string;
  gameKey: string;
  collectionName: string;
  pageSize?: number;
}

export interface CloudbaseIngestResult {
  gameKey: string;
  collectionName: string;
  imported: number;
  changed: number;
  metricDays: number;
  metricHours: number;
}

function readCredentials() {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '';
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '';
  const sessionToken = process.env.TENCENTCLOUD_SESSION_TOKEN || process.env.TENCENTCLOUD_TOKEN || '';

  if (!secretId || !secretKey) {
    throw new Error('缺少腾讯云密钥，请在 .env 设置 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY');
  }

  return { secretId, secretKey, sessionToken };
}

export async function ingestCloudbaseSnapshots(
  options: CloudbaseIngestOptions,
  onProgress?: (imported: number) => void,
): Promise<CloudbaseIngestResult> {
  if (!options.env) {
    throw new Error('缺少 CloudBase 环境 ID');
  }

  const { secretId, secretKey, sessionToken } = readCredentials();
  const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 100;
  const app = tcb.init({
    env: options.env,
    secretId,
    secretKey,
    // 临时密钥场景需要 sessionToken；长期只读子账号密钥可不填。
    sessionToken: sessionToken || undefined,
  });
  const db = app.database();
  const runId = await createIngestRun(options.gameKey, options.collectionName);
  let offset = 0;
  let imported = 0;
  let changed = 0;

  try {
    while (true) {
      const res = await db.collection(options.collectionName).skip(offset).limit(pageSize).get();
      const docs = Array.isArray(res.data) ? res.data : [];
      if (docs.length === 0) break;

      for (const doc of docs) {
        const snapshot = normalizeSnapshotDoc(doc, options.gameKey, options.collectionName);
        await upsertRawSnapshot(snapshot);
        if (await upsertSnapshotHistory(snapshot)) changed++;
      }

      imported += docs.length;
      offset += docs.length;
      onProgress?.(imported);

      if (docs.length < pageSize) break;
    }

    const dailyMetrics = await recomputeDailyMetrics(options.gameKey);
    const hourlyMetrics = await recomputeHourlyMetrics(options.gameKey);
    await finishIngestRun(runId, 'success', imported, changed);
    return {
      gameKey: options.gameKey,
      collectionName: options.collectionName,
      imported,
      changed,
      metricDays: dailyMetrics.length,
      metricHours: hourlyMetrics.length,
    };
  } catch (error) {
    await finishIngestRun(runId, 'failed', imported, changed, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

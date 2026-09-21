import { createIngestRun, finishIngestRun, upsertRawSnapshot, upsertSnapshotHistory } from './db';
import { normalizeSnapshotDoc } from './importers/snapshot-normalizer';
import { recomputeDailyMetrics, recomputeHourlyMetrics } from './metrics';
import { getTcbApp } from './tcb-client';

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

export async function ingestCloudbaseSnapshots(
  options: CloudbaseIngestOptions,
  onProgress?: (imported: number) => void,
): Promise<CloudbaseIngestResult> {
  if (!options.env) {
    throw new Error('缺少 CloudBase 环境 ID');
  }

  const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 100;
  const app = getTcbApp(options.env);
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

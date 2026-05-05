import Fastify from 'fastify';

import { getConfig } from './config';
import { getDb } from './db';
import { getDashboardData } from './dashboard';
import { ingestCloudbaseSnapshots } from './cloudbase-ingest';
import { recomputeDailyMetrics } from './metrics';
import { createMysqlPool } from './mysql';
import { startScheduler } from './scheduler';

const config = getConfig();
const app = Fastify({ logger: true });

app.get('/api/health', async () => ({
  ok: true,
  ts: Date.now(),
}));

app.get('/api/dashboard', async (request) => {
  const query = request.query as { game?: string };
  const gameKey = query.game || config.defaultGameKey;
  return getDashboardData(gameKey);
});

app.post('/api/metrics/recompute', async (request) => {
  const body = request.body as { game?: string } | undefined;
  const gameKey = body?.game || config.defaultGameKey;
  const metrics = recomputeDailyMetrics(gameKey);
  return { ok: true, gameKey, metricDays: metrics.length };
});

app.post('/api/ingest/cloudbase', async (request) => {
  const body = request.body as {
    env?: string;
    game?: string;
    collection?: string;
    limit?: number;
  } | undefined;
  const gameKey = body?.game || config.defaultGameKey;
  const result = await ingestCloudbaseSnapshots({
    env: body?.env || process.env.TCB_ENV || '',
    gameKey,
    collectionName: body?.collection || `${gameKey}_playerData`,
    pageSize: body?.limit || 100,
  });
  return { ok: true, ...result };
});

getDb();
void createMysqlPool().catch((error) => {
  app.log.error(error, 'MySQL 初始化失败，将继续使用 SQLite');
});
startScheduler();

app.listen({ port: config.apiPort, host: '127.0.0.1' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

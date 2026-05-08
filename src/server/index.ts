import Fastify from 'fastify';

import { getConfig } from './config';
import { initializeStorage } from './db';
import { getDashboardData } from './dashboard';
import { ingestCloudbaseSnapshots } from './cloudbase-ingest';
import { recomputeDailyMetrics, recomputeHourlyMetrics } from './metrics';
import { startScheduler } from './scheduler';
import { registerRealtimeRoutes } from './routes/realtime';

const config = getConfig();
const app = Fastify({ logger: true });

app.log.info({
  storageMode: config.storageMode,
  mysql: {
    host: config.mysql.host,
    port: config.mysql.port,
    database: config.mysql.database,
    user: config.mysql.user,
  },
}, '经分后端使用 MySQL 存储');

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
  const dailyMetrics = await recomputeDailyMetrics(gameKey);
  const hourlyMetrics = await recomputeHourlyMetrics(gameKey);
  return { ok: true, gameKey, metricDays: dailyMetrics.length, metricHours: hourlyMetrics.length };
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

void registerRealtimeRoutes(app).catch((error) => {
  app.log.error(error, '实时路由注册失败');
});

void initializeStorage().catch((error) => {
  app.log.error(error, '存储初始化失败');
  process.exit(1);
});
startScheduler();

app.listen({ port: config.apiPort, host: '127.0.0.1' }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});

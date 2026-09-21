// 时区锁定到 Asia/Shanghai：所有按自然日聚合的指标（user_daily / cohort_ltv / ROI 录入 / 决策）
// 都依赖 toLocalDateKey() 取服务器本地时区，部署到 UTC 容器会让事件被错切到第二天，
// 导致 first_seen_date、CPI、D0 ROI 与运营录入的 date_key 全部对不齐。
// 通过 process.env 显式声明，覆盖容器默认 TZ，未设置时强制使用上海时区。
if (!process.env.TZ) {
  process.env.TZ = 'Asia/Shanghai';
}

import { installProcessLifecycleLogging, getProcessLogPath } from './process-lifecycle';

installProcessLifecycleLogging();

import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { getConfig } from './config';
import { initializeStorage } from './db';
import { getDashboardData } from './dashboard';
import { ingestCloudbaseSnapshots } from './cloudbase-ingest';
import { recomputeDailyMetrics, recomputeHourlyMetrics } from './metrics';
import { startScheduler } from './scheduler';
import { registerRealtimeRoutes } from './routes/realtime';
import { initSnapshotStorage } from './snapshot-db';

const config = getConfig();
const app = Fastify({ logger: true });

function expectedBasicAuthorization(password: string): string {
  return `Basic ${Buffer.from(`ga:${password}`).toString('base64')}`;
}

app.addHook('onRequest', async (request, reply) => {
  const password = process.env.GA_ACCESS_PASSWORD;
  if (!password) return;
  const urlPath = (request.url || '').split('?')[0];
  if (urlPath === '/api/health') return;
  const header = request.headers.authorization || '';
  if (header !== expectedBasicAuthorization(password)) {
    reply.header('WWW-Authenticate', 'Basic realm="Game Analysis"');
    return reply.code(401).send({ error: 'Unauthorized' });
  }
});

app.log.info({
  storageMode: config.storageMode,
  tz: process.env.TZ,
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

async function start(): Promise<void> {
  await registerRealtimeRoutes(app);

  const distDir = path.join(config.rootDir, 'dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: distDir,
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      const urlPath = (request.url || '').split('?')[0];
      if (urlPath.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port: config.apiPort, host: config.apiHost });
  app.log.info(
    { processLog: getProcessLogPath(), host: config.apiHost, port: config.apiPort },
    '进程诊断日志已启用（uncaughtException / 信号 / 心跳）',
  );

  try {
    await initializeStorage();
    await initSnapshotStorage();
  } catch (error) {
    app.log.error(error, '存储初始化失败');
    process.exit(1);
  }
  startScheduler();
}

void start().catch((error) => {
  app.log.error(error, '服务启动失败');
  process.exit(1);
});

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
import { findAnalyticsGame } from './config/analytics-games';
import { initSnapshotStorage } from './snapshot-db';
import { ensureAllGameIcons, resolveServedGameIconFile } from './game-icons';

const config = getConfig();
const PUBLIC_PREFIX = '/game-analysis';

function stripPublicPrefix(url: string): string {
  const q = url.indexOf('?');
  const pathname = q >= 0 ? url.slice(0, q) : url;
  const search = q >= 0 ? url.slice(q) : '';
  if (pathname === PUBLIC_PREFIX || pathname.startsWith(`${PUBLIC_PREFIX}/`)) {
    return `${pathname.slice(PUBLIC_PREFIX.length) || '/'}${search}`;
  }
  return url;
}

const app = Fastify({
  logger: true,
  rewriteUrl: (req) => stripPublicPrefix(req.url || '/'),
});

function expectedBasicAuthorization(password: string): string {
  return `Basic ${Buffer.from(`ga:${password}`).toString('base64')}`;
}

function canonicalRequestGameKey(gameKey: string): string {
  return findAnalyticsGame(gameKey)?.gameKey || gameKey;
}

app.addHook('preHandler', async (request) => {
  const query = request.query as { game?: string } | undefined;
  if (query && typeof query.game === 'string' && query.game) {
    query.game = canonicalRequestGameKey(query.game);
  }
  const body = request.body as { game?: string } | null | undefined;
  if (body && typeof body === 'object' && typeof body.game === 'string' && body.game) {
    body.game = canonicalRequestGameKey(body.game);
  }
});

app.addHook('onRequest', async (request, reply) => {
  const password = process.env.GA_BASIC_AUTH_PASSWORD || process.env.GA_ACCESS_PASSWORD;
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

app.get('/api/health', async () => {
  const icons = await ensureAllGameIcons({ autoPull: false });
  return {
    ok: true,
    ts: Date.now(),
    icons: {
      total: icons.total,
      ready: icons.ready,
      missing: icons.missing,
    },
  };
});

app.get('/api/games/icons/status', async () => {
  return ensureAllGameIcons({ autoPull: false });
});

app.post('/api/games/icons/sync', async (request) => {
  const query = request.query as { force?: string } | undefined;
  const body = request.body as { force?: boolean } | null | undefined;
  const forceRefresh = query?.force === '1' || query?.force === 'true' || body?.force === true;
  return ensureAllGameIcons({ autoPull: true, forceRefresh });
});

app.get('/game-icons/:filename', async (request, reply) => {
  const { filename } = request.params as { filename: string };
  const resolved = await resolveServedGameIconFile(filename);
  if (!resolved) {
    return reply.code(404).type('application/json').send({ error: 'Game icon not found', filename });
  }
  reply.header('Cache-Control', 'public, max-age=3600');
  return reply.type(resolved.mimeType).send(fs.createReadStream(resolved.filePath));
});

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
      if (urlPath.startsWith('/api/') || urlPath.startsWith('/game-icons/')) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // 云托管探活看端口是否起来。必须先连上 MySQL，再 listen，避免探活 200 后进程因连库失败退出。
  try {
    await initializeStorage();
    await initSnapshotStorage();
  } catch (error) {
    app.log.error(error, '存储初始化失败');
    process.exit(1);
  }

  // 启动时自动校验全部小游戏图标，缺失时从微信公众平台官方头像或本地工程目录补拉并同步 dist/
  void ensureAllGameIcons({ autoPull: true })
    .then((report) => {
      if (report.missing.length > 0) {
        app.log.warn(
          { missing: report.missing, ready: report.ready, total: report.total },
          '检测到部分小游戏图标缺失且自动拉取未成功，请检查 wechatAppId / iconUrl 或 public/game-icons/',
        );
      } else {
        app.log.info(
          { total: report.total, ready: report.ready, pulled: report.pulled },
          '全部小游戏图标完整性校验通过',
        );
      }
    })
    .catch((error) => {
      app.log.warn(error, '启动时小游戏图标自动检测异常');
    });

  await app.listen({ port: config.apiPort, host: config.apiHost });
  app.log.info(
    { processLog: getProcessLogPath(), host: config.apiHost, port: config.apiPort },
    '进程诊断日志已启用（uncaughtException / 信号 / 心跳）',
  );
  startScheduler();
}

void start().catch((error) => {
  app.log.error(error, '服务启动失败');
  process.exit(1);
});

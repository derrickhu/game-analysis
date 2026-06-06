import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'api-process.log');
const HEARTBEAT_MS = Number(process.env.API_HEARTBEAT_MS) || 10 * 60_000;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack || ''}`;
  }
  return String(error);
}

function isBrokenPipeError(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException;
  return err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED';
}

function safeConsoleWrite(line: string, isError: boolean): void {
  try {
    if (isError) console.error(line);
    else console.log(line);
  } catch (error) {
    if (!isBrokenPipeError(error)) throw error;
    // 终端/管道已关闭（后台跑、IDE 停掉输出）时禁止因 EPIPE 拖垮整个 API
  }
}

function writeLog(level: string, message: string, detail?: string): void {
  const line = `[${new Date().toISOString()}] [${level}] [pid=${process.pid}] ${message}${detail ? `\n${detail}` : ''}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // 落盘失败时仍尝试控制台
  }
  safeConsoleWrite(line.trimEnd(), level === 'ERROR' || level === 'FATAL');
}

function memSnapshot(): string {
  const m = process.memoryUsage();
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `rss=${mb(m.rss)} heap=${mb(m.heapUsed)}/${mb(m.heapTotal)} ext=${mb(m.external)}`;
}

let heartbeatTimer: NodeJS.Timeout | null = null;
let lifecycleInstalled = false;

/**
 * 进程级诊断：未捕获异常、信号、退出原因、定期心跳。
 * 日志写入 logs/api-process.log（已在 .gitignore），终端关掉后仍可查上次挂掉前发生了什么。
 */
export function installProcessLifecycleLogging(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;

  writeLog('INFO', `process start argv=${process.argv.join(' ')} cwd=${process.cwd()} ${memSnapshot()}`);

  process.on('uncaughtException', (error) => {
    if (isBrokenPipeError(error)) {
      writeLog('WARN', 'uncaughtException EPIPE（stdout 已断开，忽略并继续运行）');
      return;
    }
    writeLog('FATAL', 'uncaughtException — 进程即将退出', formatError(error));
    setTimeout(() => process.exit(1), 200);
  });

  process.on('unhandledRejection', (reason) => {
    writeLog('ERROR', 'unhandledRejection', formatError(reason));
  });

  process.on('beforeExit', (code) => {
    writeLog('WARN', `beforeExit code=${code}`);
  });

  process.on('exit', (code) => {
    writeLog('WARN', `exit code=${code}`);
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      writeLog('WARN', `received ${signal} — 通常为用户/系统主动结束进程`);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      process.exit(signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
    });
  }

  heartbeatTimer = setInterval(() => {
    writeLog('INFO', `heartbeat uptime=${Math.floor(process.uptime())}s ${memSnapshot()}`);
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

/** 供 scheduler 等异步任务包裹，避免 Promise 拒绝冒泡成 unhandledRejection */
export function runLoggedTask(label: string, task: () => Promise<void>): void {
  const started = Date.now();
  void task()
    .then(() => {
      const ms = Date.now() - started;
      if (ms > 120_000) {
        writeLog('WARN', `${label} 耗时较长: ${ms}ms`);
      }
    })
    .catch((error) => {
      writeLog('ERROR', `${label} 失败`, formatError(error));
    });
}

export function getProcessLogPath(): string {
  return LOG_FILE;
}

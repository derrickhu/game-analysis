import { execSync, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const logDir = path.join(root, 'run');
mkdirSync(logDir, { recursive: true });

function killPort(port) {
  let output = '';
  try {
    output = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8' }).trim();
  } catch {
    return;
  }
  for (const pid of output.split(/\s+/).filter(Boolean)) {
    try {
      process.kill(Number(pid), 'SIGTERM');
      console.log(`[demo:restart] stopped pid=${pid} port=${port}`);
    } catch (error) {
      console.warn(`[demo:restart] stop pid=${pid} failed: ${error.message}`);
    }
  }
}

function start(name, args, logName) {
  const logPath = path.join(logDir, logName);
  const out = openSync(logPath, 'a');
  const child = spawn('npm', args, {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  console.log(`[demo:restart] started ${name} pid=${child.pid} log=${logPath}`);
}

killPort(5173);
killPort(8787);

setTimeout(() => {
  start('api', ['run', 'api'], 'demo-api.log');
  start('dev', ['run', 'dev'], 'demo-dev.log');
}, 500);

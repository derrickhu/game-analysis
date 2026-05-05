import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  dbPath: string;
  apiPort: number;
  defaultGameKey: string;
  storageMode: 'sqlite' | 'mysql';
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  schedulerEnabled: boolean;
}

function readNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getConfig(): AppConfig {
  const dataDir = process.env.GA_DATA_DIR
    ? path.resolve(process.env.GA_DATA_DIR)
    : path.join(rootDir, 'data');

  return {
    rootDir,
    dataDir,
    dbPath: process.env.GA_DB_PATH
      ? path.resolve(process.env.GA_DB_PATH)
      : path.join(dataDir, 'game-analysis.sqlite'),
    apiPort: readNumber('GA_API_PORT', 8787),
    defaultGameKey: process.env.GA_GAME_KEY || 'huahua',
    storageMode: process.env.GA_STORAGE === 'mysql' ? 'mysql' : 'sqlite',
    mysql: {
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: readNumber('MYSQL_PORT', 3306),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'game_analysis',
    },
    schedulerEnabled: process.env.GA_SCHEDULER_ENABLED === 'true',
  };
}

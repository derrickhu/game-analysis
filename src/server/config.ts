import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTencentAdsConfig, type TencentAdsConfig } from './config/tencent-ads';
import { getWechatPublisherConfig, type WechatPublisherConfig } from './config/wechat-publisher';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  dbPath: string;
  apiPort: number;
  defaultGameKey: string;
  storageMode: 'mysql';
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  schedulerEnabled: boolean;
  tencentAds: TencentAdsConfig;
  wechatPublisher: WechatPublisherConfig;
}

function readNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readRequiredString(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少必需的 MySQL 配置: ${name}`);
  }
  return value;
}

function readRequiredNumber(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`缺少或非法的 MySQL 配置: ${name}`);
  }
  return value;
}

function readMysqlPassword(): string {
  // 密码允许为空字符串，但必须在环境变量中显式声明，避免误以为读到了 .env。
  if (process.env.MYSQL_PASSWORD === undefined) {
    throw new Error('缺少必需的 MySQL 配置: MYSQL_PASSWORD（如无密码请显式设置为空字符串）');
  }
  return process.env.MYSQL_PASSWORD;
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
    defaultGameKey: process.env.GA_GAME_KEY || 'hotpot',
    storageMode: 'mysql',
    mysql: {
      host: readRequiredString('MYSQL_HOST'),
      port: readRequiredNumber('MYSQL_PORT'),
      user: readRequiredString('MYSQL_USER'),
      password: readMysqlPassword(),
      database: readRequiredString('MYSQL_DATABASE'),
    },
    schedulerEnabled: process.env.GA_SCHEDULER_ENABLED === 'true',
    tencentAds: getTencentAdsConfig(),
    wechatPublisher: getWechatPublisherConfig(),
  };
}

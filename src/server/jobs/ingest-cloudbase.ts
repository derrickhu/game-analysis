import { getConfig } from '../config';
import { ingestCloudbaseSnapshots } from '../cloudbase-ingest';

function readArg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const config = getConfig();
const gameKey = readArg('game', config.defaultGameKey);
const collectionName = readArg('collection', `${gameKey}_playerData`);
const env = readArg('env', process.env.TCB_ENV || '');
const pageSize = Number(readArg('limit', '100'));

if (!env) {
  throw new Error('缺少 CloudBase 环境 ID，请传 --env=xxx 或设置 TCB_ENV');
}

const result = await ingestCloudbaseSnapshots(
  { env, gameKey, collectionName, pageSize },
  (imported) => console.log(`已导入 ${imported} 条 ${collectionName} 快照`),
);
console.log(
  `CloudBase 导入完成: game=${gameKey}, snapshots=${result.imported}, changed=${result.changed}, metricDays=${result.metricDays}, metricHours=${result.metricHours}`,
);

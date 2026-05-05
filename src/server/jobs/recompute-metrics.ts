import { getConfig } from '../config';
import { closeStorage } from '../db';
import { recomputeDailyMetrics, recomputeHourlyMetrics } from '../metrics';

function readArg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const gameKey = readArg('game', getConfig().defaultGameKey);
const dailyMetrics = await recomputeDailyMetrics(gameKey);
const hourlyMetrics = await recomputeHourlyMetrics(gameKey);

console.log(`指标重算完成: game=${gameKey}, metricDays=${dailyMetrics.length}, metricHours=${hourlyMetrics.length}`);
await closeStorage();

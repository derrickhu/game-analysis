import 'dotenv/config';

import { closeStorage } from '../db';
import { recomputeCohortLtv, recomputeUserDaily } from '../metrics/ltv';
import { getConfig } from '../config';

function readArg(name: string, fallback = ''): string {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) || fallback;
}

const gameKey = readArg('game', getConfig().defaultGameKey);
const fromDate = readArg('from');
const toDate = readArg('to');

try {
  const userDaily = await recomputeUserDaily(gameKey, {
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
  });
  const ltv = await recomputeCohortLtv(gameKey, {
    fromCohortDate: fromDate || undefined,
    toCohortDate: toDate || undefined,
  });

  console.log(
    `LTV 回算完成: game=${gameKey}, userDailyRows=${userDaily.rows}, ` +
      `cohortRows=${ltv.rows}, range=${userDaily.from_date}~${userDaily.to_date}`,
  );
} finally {
  await closeStorage();
}

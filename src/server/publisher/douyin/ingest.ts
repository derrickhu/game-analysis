import { getConfig } from '../../config';
import type { DouyinPublisherGameMapping } from './config';
import {
  listBusinessDailyInputs,
  recordDouyinPublisherIngestRun,
  rebuildBusinessMonthlyRevenue,
  replaceDouyinPublisherAdDailyRows,
  upsertBusinessDailyInput,
  type BusinessDailyInputRow,
  type DouyinPublisherAdDailyRow,
} from '../../ltv-db';
import { getDouyinPublisherAdIncome, type DouyinPublisherAdDataItem } from './client';
import { toShanghaiDateKey } from '../../time';

export interface DouyinPublisherIngestGameSummary {
  game_key: string;
  app_id: string;
  from_date: string;
  to_date: string;
  fetched_rows: number;
  saved_raw_rows: number;
  saved_business_rows: number;
  skipped: boolean;
  error?: string;
}

export interface DouyinPublisherIngestSummary {
  ok: boolean;
  from_date: string;
  to_date: string;
  games: DouyinPublisherIngestGameSummary[];
}

function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00+08:00`);
  date.setDate(date.getDate() + days);
  return toShanghaiDateKey(date.getTime());
}

function yesterday(): string {
  return toShanghaiDateKey(Date.now() - 86_400_000);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dimensionKey(row: DouyinPublisherAdDataItem): string {
  return [row.host_app || '-', row.os || '-', row.channel || '-', row.ad_type || '-'].join('|');
}

function buildRawRows(gameKey: string, rows: DouyinPublisherAdDataItem[]): DouyinPublisherAdDailyRow[] {
  const now = Date.now();
  const merged = new Map<string, DouyinPublisherAdDailyRow>();
  for (const row of rows) {
    if (!row.date) continue;
    const hostName = dimensionKey(row);
    const key = `${row.date}\t${hostName}`;
    const existing = merged.get(key);
    const incomeCny = round2(Number(row.income_after_share || 0) + Number(existing?.income_cny || 0));
    merged.set(key, {
      game_key: gameKey,
      date_key: row.date,
      host_name: hostName,
      income_cny: incomeCny,
      raw_json: JSON.stringify(row),
      updated_at: now,
    });
  }
  return [...merged.values()];
}

function aggregateByDate(rows: DouyinPublisherAdDataItem[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row.date) continue;
    totals.set(row.date, round2((totals.get(row.date) || 0) + Number(row.income_after_share || 0)));
  }
  return totals;
}

function buildAutoNote(incomeCny: number): string {
  return `抖音流量主自动补录：分成后 ${incomeCny.toFixed(2)} 元`;
}

function mergeNote(existing: BusinessDailyInputRow | undefined, autoNote: string): string {
  const existingNote = existing?.note?.trim() || '';
  const manualNote = existingNote
    .split('\n')
    .filter((line) => !line.startsWith('抖音流量主自动补录：'))
    .join('\n')
    .trim();
  return manualNote ? `${manualNote}\n${autoNote}` : autoNote;
}

async function ingestMapping(
  mapping: DouyinPublisherGameMapping,
  fromDate: string,
  toDate: string,
): Promise<DouyinPublisherIngestGameSummary> {
  try {
    const report = await getDouyinPublisherAdIncome({ mapping, fromDate, toDate });
    const rawRows = buildRawRows(mapping.gameKey, report.rows);
    const dailyTotals = aggregateByDate(report.rows);
    const nonzero = [...dailyTotals.values()].filter((value) => value > 0).length;
    console.log(
      `[douyin_publisher] ${mapping.gameKey} ${fromDate}~${toDate} fetched=${report.total} dates=${dailyTotals.size} nonzero=${nonzero}`,
    );
    const existingRows = await listBusinessDailyInputs(mapping.gameKey, fromDate, toDate);
    const existingByDate = new Map(existingRows.map((row) => [row.date_key, row]));

    const savedRawRows = await replaceDouyinPublisherAdDailyRows(mapping.gameKey, fromDate, toDate, rawRows);
    let savedBusinessRows = 0;
    for (const [dateKey, incomeCny] of dailyTotals) {
      const existing = existingByDate.get(dateKey);
      const existingIncome = Number(existing?.douyin_ad_revenue_cny || 0);
      // 接口偶发回 0 时不要盖掉已有分成后收入（人工补录或上次成功拉取）。
      if (incomeCny <= 0 && existingIncome > 0) {
        continue;
      }
      await upsertBusinessDailyInput({
        game_key: mapping.gameKey,
        date_key: dateKey,
        spend_cny: Number(existing?.spend_cny || 0),
        wechat_clicks: Number(existing?.wechat_clicks || 0),
        wechat_ad_revenue_cny: Number(existing?.wechat_ad_revenue_cny || 0),
        wechat_ad_impressions: Number(existing?.wechat_ad_impressions || 0),
        douyin_ad_revenue_cny: incomeCny,
        acquisition_impressions: Number(existing?.acquisition_impressions || 0),
        acquisition_activations: Number(existing?.acquisition_activations || 0),
        acquisition_source: existing?.acquisition_source || '',
        note: mergeNote(existing, buildAutoNote(incomeCny)),
      });
      savedBusinessRows += 1;
    }

    return {
      game_key: mapping.gameKey,
      app_id: mapping.appId,
      from_date: fromDate,
      to_date: toDate,
      fetched_rows: report.total,
      saved_raw_rows: savedRawRows,
      saved_business_rows: savedBusinessRows,
      skipped: false,
    };
  } catch (error) {
    return {
      game_key: mapping.gameKey,
      app_id: mapping.appId,
      from_date: fromDate,
      to_date: toDate,
      fetched_rows: 0,
      saved_raw_rows: 0,
      saved_business_rows: 0,
      skipped: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function ingestDouyinPublisherBusinessInputs(options: {
  fromDate?: string;
  toDate?: string;
  gameKey?: string;
  triggerSource?: 'cron' | 'startup' | 'manual';
} = {}): Promise<DouyinPublisherIngestSummary> {
  const startedAt = Date.now();
  const triggerSource = options.triggerSource || 'manual';
  const config = getConfig().douyinPublisher;
  const toDate = options.toDate || yesterday();
  const lookbackDays = Math.max(1, Math.min(90, Number(process.env.DOUYIN_PUBLISHER_INGEST_LOOKBACK_DAYS) || 90));
  const fromDate = options.fromDate || addDays(toDate, -(lookbackDays - 1));
  const recordRun = async (summary: DouyinPublisherIngestSummary, errorMessage = '') => {
    try {
      const finishedAt = Date.now();
      await recordDouyinPublisherIngestRun({
        trigger_source: triggerSource,
        game_key: options.gameKey,
        from_date: summary.from_date,
        to_date: summary.to_date,
        ok: summary.ok,
        games_json: JSON.stringify(summary.games),
        error_message: errorMessage,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: finishedAt - startedAt,
      });
    } catch (error) {
      console.warn('[douyin_publisher] 记录拉取日志失败:', error);
    }
  };

  if (!config.enabled) {
    const summary = { ok: true, from_date: fromDate, to_date: toDate, games: [] };
    await recordRun(summary);
    return summary;
  }

  const mappings = config.gameMappings.filter((mapping) => !options.gameKey || mapping.gameKey === options.gameKey);
  const games: DouyinPublisherIngestGameSummary[] = [];
  for (const mapping of mappings) {
    games.push(await ingestMapping(mapping, fromDate, toDate));
  }

  const summary = {
    ok: games.every((game) => !game.error),
    from_date: fromDate,
    to_date: toDate,
    games,
  };
  const rebuiltKeys = games.filter((game) => !game.error && !game.skipped).map((game) => game.game_key);
  if (rebuiltKeys.length > 0) {
    try {
      const monthAgo = new Date(`${toDate}T00:00:00+08:00`);
      monthAgo.setMonth(monthAgo.getMonth() - 11);
      monthAgo.setDate(1);
      const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
      const fromMonthDate = `${monthAgo.getFullYear()}-${pad(monthAgo.getMonth() + 1)}-01`;
      await rebuildBusinessMonthlyRevenue({
        gameKeys: rebuiltKeys,
        fromDate: fromMonthDate,
        toDate,
      });
    } catch (error) {
      console.warn('[douyin_publisher] 月度收益汇总失败:', error);
    }
  }
  await recordRun(summary, games.map((game) => game.error).filter(Boolean).join('\n'));
  return summary;
}

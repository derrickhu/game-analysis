import { getConfig } from '../config';
import type { WechatPublisherGameMapping } from '../config/wechat-publisher';
import {
  listBusinessDailyInputs,
  recordWechatPublisherIngestRun,
  rebuildBusinessMonthlyRevenue,
  replaceWechatPublisherAdDailyRows,
  upsertBusinessDailyInput,
  type BusinessDailyInputRow,
  type WechatPublisherAdDailyRow,
} from '../ltv-db';
import { getWechatPublisherAdposGeneral, type WechatPublisherAdposRow } from '../wechat-publisher';
import { toShanghaiDateKey } from '../time';

export interface WechatPublisherIngestGameSummary {
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

export interface WechatPublisherIngestSummary {
  ok: boolean;
  from_date: string;
  to_date: string;
  games: WechatPublisherIngestGameSummary[];
}

interface AggregatedPublisherDaily {
  dateKey: string;
  incomeCny: number;
  exposureCount: number;
  clickCount: number;
  reqSuccCount: number;
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

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function fenToCny(value: number): number {
  return round2(Number(value || 0) / 100);
}

function buildRawRows(gameKey: string, rows: WechatPublisherAdposRow[]): WechatPublisherAdDailyRow[] {
  const now = Date.now();
  return rows
    .filter((row) => row.date)
    .map((row) => {
      const exposureCount = Math.max(0, Math.trunc(Number(row.exposure_count || 0)));
      const incomeCny = fenToCny(Number(row.income || 0));
      const ecpmCny = exposureCount > 0 ? round4((incomeCny / exposureCount) * 1000) : 0;
      return {
        game_key: gameKey,
        date_key: row.date,
        slot_id: String(row.slot_str || row.slot_id || row.ad_slot || 'unknown'),
        ad_slot: row.ad_slot || '',
        req_succ_count: Math.max(0, Math.trunc(Number(row.req_succ_count || 0))),
        exposure_count: exposureCount,
        exposure_rate: Number(row.exposure_rate || 0),
        click_count: Math.max(0, Math.trunc(Number(row.click_count || 0))),
        click_rate: Number(row.click_rate || 0),
        income_cny: incomeCny,
        ecpm_cny: ecpmCny,
        raw_json: JSON.stringify(row),
        updated_at: now,
      };
    });
}

function aggregateDaily(rows: WechatPublisherAdposRow[]): AggregatedPublisherDaily[] {
  const byDate = new Map<string, AggregatedPublisherDaily>();
  for (const row of rows) {
    if (!row.date) continue;
    const current =
      byDate.get(row.date) || {
        dateKey: row.date,
        incomeCny: 0,
        exposureCount: 0,
        clickCount: 0,
        reqSuccCount: 0,
      };
    current.incomeCny += Number(row.income || 0) / 100;
    current.exposureCount += Math.max(0, Math.trunc(Number(row.exposure_count || 0)));
    current.clickCount += Math.max(0, Math.trunc(Number(row.click_count || 0)));
    current.reqSuccCount += Math.max(0, Math.trunc(Number(row.req_succ_count || 0)));
    byDate.set(row.date, current);
  }
  return [...byDate.values()].map((row) => ({
    ...row,
    incomeCny: round2(row.incomeCny),
  }));
}

function buildAutoNote(row: AggregatedPublisherDaily): string {
  const ecpm = row.exposureCount > 0 ? round4((row.incomeCny / row.exposureCount) * 1000) : 0;
  return `微信流量主自动补录：收入 ${row.incomeCny.toFixed(2)} 元，曝光 ${row.exposureCount}，点击 ${row.clickCount}，eCPM ${ecpm.toFixed(4)} 元`;
}

function mergeNote(existing: BusinessDailyInputRow | undefined, autoNote: string): string {
  const existingNote = existing?.note?.trim() || '';
  const manualNote = existingNote
    .split('\n')
    .filter((line) => !line.startsWith('微信流量主自动补录：'))
    .join('\n')
    .trim();
  return manualNote ? `${manualNote}\n${autoNote}` : autoNote;
}

async function ingestMapping(
  mapping: WechatPublisherGameMapping,
  fromDate: string,
  toDate: string,
): Promise<WechatPublisherIngestGameSummary> {
  try {
    const report = await getWechatPublisherAdposGeneral({ mapping, fromDate, toDate });
    const rawRows = buildRawRows(mapping.gameKey, report.rows);
    const dailyRows = aggregateDaily(report.rows);
    const existingRows = await listBusinessDailyInputs(mapping.gameKey, fromDate, toDate);
    const existingByDate = new Map(existingRows.map((row) => [row.date_key, row]));

    const savedRawRows = await replaceWechatPublisherAdDailyRows(mapping.gameKey, fromDate, toDate, rawRows);
    let savedBusinessRows = 0;
    for (const row of dailyRows) {
      const existing = existingByDate.get(row.dateKey);
      await upsertBusinessDailyInput({
        game_key: mapping.gameKey,
        date_key: row.dateKey,
        spend_cny: Number(existing?.spend_cny || 0),
        wechat_clicks: Number(existing?.wechat_clicks || 0),
        wechat_ad_revenue_cny: row.incomeCny,
        wechat_ad_impressions: row.exposureCount,
        acquisition_impressions: Number(existing?.acquisition_impressions || 0),
        acquisition_activations: Number(existing?.acquisition_activations || 0),
        acquisition_source: existing?.acquisition_source || '',
        note: mergeNote(existing, buildAutoNote(row)),
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

export async function ingestWechatPublisherBusinessInputs(options: {
  fromDate?: string;
  toDate?: string;
  gameKey?: string;
  triggerSource?: 'cron' | 'startup' | 'manual';
} = {}): Promise<WechatPublisherIngestSummary> {
  const startedAt = Date.now();
  const triggerSource = options.triggerSource || 'manual';
  const config = getConfig().wechatPublisher;
  const toDate = options.toDate || yesterday();
  const lookbackDays = Math.max(1, Math.min(90, Number(process.env.WECHAT_PUBLISHER_INGEST_LOOKBACK_DAYS) || 90));
  const fromDate = options.fromDate || addDays(toDate, -(lookbackDays - 1));
  const recordRun = async (summary: WechatPublisherIngestSummary, errorMessage = '') => {
    try {
      const finishedAt = Date.now();
      await recordWechatPublisherIngestRun({
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
      console.warn('[wechat_publisher] 记录拉取日志失败:', error);
    }
  };

  if (!config.enabled) {
    const summary = { ok: true, from_date: fromDate, to_date: toDate, games: [] };
    await recordRun(summary);
    return summary;
  }

  const mappings = config.gameMappings.filter((mapping) => !options.gameKey || mapping.gameKey === options.gameKey);
  const games: WechatPublisherIngestGameSummary[] = [];
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
      console.warn('[wechat_publisher] 月度收益汇总失败:', error);
    }
  }
  await recordRun(summary, games.map((game) => game.error).filter(Boolean).join('\n'));
  return summary;
}

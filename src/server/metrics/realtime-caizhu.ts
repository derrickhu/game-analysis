import { getDb, getMysqlPool, isMysqlMode } from '../db';

const USER_KEY_SQL = "COALESCE(NULLIF(user_id, ''), anonymous_id)";

const CAIZHU_EVENTS = [
  'gameplay_mode_enter',
  'classic_start',
  'classic_end',
  'classic_quit',
  'level_select',
  'prop_request',
  'prop_use',
  'tutorial_step',
] as const;

interface AnalyticsRow {
  event_name: string;
  uk: string;
  params_json: unknown;
}

export interface CaizhuGameplayOverview {
  kpi: {
    mode_enter_users: number;
    classic_start_count: number;
    classic_end_count: number;
    classic_users: number;
    avg_classic_score: number;
    avg_classic_duration_ms: number;
    level_select_count: number;
    prop_request_count: number;
    prop_use_count: number;
    tutorial_step_count: number;
    computed_at: number;
  };
  mode_entries: Array<{ mode: string; count: number; users: number }>;
  prop_usage: Array<{ prop_type: string; requests: number; uses: number; use_rate: number | null }>;
  tutorial_steps: Array<{ step_id: string; done: number; skip: number }>;
}

export async function getCaizhuGameplayOverview(
  gameKey: string,
  fromTs: number,
  toTs: number,
): Promise<CaizhuGameplayOverview> {
  const rows = await listRows(gameKey, fromTs, toTs);
  const classicStarts = rows.filter((row) => row.event_name === 'classic_start');
  const classicEnds = rows.filter((row) => row.event_name === 'classic_end');
  const scores = classicEnds.map((row) => numParam(row, 'score')).filter((v) => v > 0);
  const durations = classicEnds.map((row) => numParam(row, 'duration_ms')).filter((v) => v > 0);

  return {
    kpi: {
      mode_enter_users: new Set(rows.filter((row) => row.event_name === 'gameplay_mode_enter').map((row) => row.uk)).size,
      classic_start_count: classicStarts.length,
      classic_end_count: classicEnds.length,
      classic_users: new Set(classicStarts.map((row) => row.uk)).size,
      avg_classic_score: avg(scores),
      avg_classic_duration_ms: avg(durations),
      level_select_count: rows.filter((row) => row.event_name === 'level_select').length,
      prop_request_count: rows.filter((row) => row.event_name === 'prop_request').length,
      prop_use_count: rows.filter((row) => row.event_name === 'prop_use').length,
      tutorial_step_count: rows.filter((row) => row.event_name === 'tutorial_step').length,
      computed_at: Date.now(),
    },
    mode_entries: buildModeEntries(rows),
    prop_usage: buildPropUsage(rows),
    tutorial_steps: buildTutorialSteps(rows),
  };
}

async function listRows(gameKey: string, fromTs: number, toTs: number): Promise<AnalyticsRow[]> {
  const placeholders = CAIZHU_EVENTS.map(() => '?').join(',');
  const sql = `SELECT event_name, ${USER_KEY_SQL} AS uk, params_json
                 FROM analytics_events
                WHERE game_key = ?
                  AND event_name IN (${placeholders})
                  AND event_ts BETWEEN ? AND ?`;
  if (isMysqlMode()) {
    const pool = await getMysqlPool();
    const [rows] = await pool.query(sql, [gameKey, ...CAIZHU_EVENTS, fromTs, toTs]);
    return rows as AnalyticsRow[];
  }
  return getDb().prepare(sql).all(gameKey, ...CAIZHU_EVENTS, fromTs, toTs) as AnalyticsRow[];
}

function buildModeEntries(rows: AnalyticsRow[]): CaizhuGameplayOverview['mode_entries'] {
  const map = new Map<string, { mode: string; count: number; users: Set<string> }>();
  for (const row of rows.filter((r) => r.event_name === 'gameplay_mode_enter')) {
    const mode = strParam(row, 'mode', 'unknown');
    const item = map.get(mode) || { mode, count: 0, users: new Set<string>() };
    item.count += 1;
    if (row.uk) item.users.add(row.uk);
    map.set(mode, item);
  }
  return Array.from(map.values())
    .map((row) => ({ mode: row.mode, count: row.count, users: row.users.size }))
    .sort((a, b) => b.count - a.count);
}

function buildPropUsage(rows: AnalyticsRow[]): CaizhuGameplayOverview['prop_usage'] {
  const map = new Map<string, { prop_type: string; requests: number; uses: number }>();
  for (const row of rows.filter((r) => r.event_name === 'prop_request' || r.event_name === 'prop_use')) {
    const propType = strParam(row, 'prop_type', 'unknown');
    const item = map.get(propType) || { prop_type: propType, requests: 0, uses: 0 };
    if (row.event_name === 'prop_request') item.requests += 1;
    if (row.event_name === 'prop_use') item.uses += 1;
    map.set(propType, item);
  }
  return Array.from(map.values())
    .map((row) => ({ ...row, use_rate: row.requests > 0 ? row.uses / row.requests : null }))
    .sort((a, b) => b.requests - a.requests);
}

function buildTutorialSteps(rows: AnalyticsRow[]): CaizhuGameplayOverview['tutorial_steps'] {
  const map = new Map<string, { step_id: string; done: number; skip: number }>();
  for (const row of rows.filter((r) => r.event_name === 'tutorial_step')) {
    const stepId = strParam(row, 'step_id', 'unknown');
    const status = strParam(row, 'status', 'done');
    const item = map.get(stepId) || { step_id: stepId, done: 0, skip: 0 };
    if (status === 'skip') item.skip += 1;
    else item.done += 1;
    map.set(stepId, item);
  }
  return Array.from(map.values());
}

function paramsOf(row: AnalyticsRow): Record<string, unknown> {
  const raw = row.params_json;
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function strParam(row: AnalyticsRow, key: string, fallback: string): string {
  const value = paramsOf(row)[key];
  return value === undefined || value === null || value === '' ? fallback : String(value);
}

function numParam(row: AnalyticsRow, key: string): number {
  const value = Number(paramsOf(row)[key]);
  return Number.isFinite(value) ? value : 0;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
}

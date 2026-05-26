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

/**
 * 经典模式「创新高」事件的分数段分桶。
 * 关卡设计基线：要让玩家在 X 分段「自然」达成（≈中位数步数）需要多少回合预算。
 *
 * 数据来源：classic_end / classic_quit 事件中 is_new_best=true 的记录，
 * 每条携带 score 和 steps_used。
 */
export interface BestScoreRunBucket {
  range_label: string;
  score_min: number;
  /** 上限不含；最后一个桶为 Number.POSITIVE_INFINITY */
  score_max: number;
  count: number;
  unique_users: number;
  avg_steps: number;
  median_steps: number;
  avg_score: number;
}

export interface BestScoreRunsSummary {
  total: number;
  unique_users: number;
  avg_steps: number;
  median_steps: number;
  avg_score: number;
  /** 按 score 升序的所有创新高事件（去掉异常 0 步），方便前端做散点 */
  samples: Array<{ score: number; steps_used: number; user_key: string }>;
  buckets: BestScoreRunBucket[];
}

export interface CaizhuGameplayOverview {
  kpi: {
    mode_enter_users: number;
    classic_start_count: number;
    classic_end_count: number;
    classic_users: number;
    avg_classic_score: number;
    avg_classic_duration_ms: number;
    classic_new_best_count: number;
    classic_avg_steps_new_best: number;
    level_select_count: number;
    prop_request_count: number;
    prop_use_count: number;
    tutorial_step_count: number;
    computed_at: number;
  };
  mode_entries: Array<{ mode: string; count: number; users: number }>;
  prop_usage: Array<{ prop_type: string; requests: number; uses: number; use_rate: number | null }>;
  tutorial_steps: Array<{ step_id: string; done: number; skip: number }>;
  best_score_runs: BestScoreRunsSummary;
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
  const bestScoreRuns = buildBestScoreRuns(rows);

  return {
    kpi: {
      mode_enter_users: new Set(rows.filter((row) => row.event_name === 'gameplay_mode_enter').map((row) => row.uk)).size,
      classic_start_count: classicStarts.length,
      classic_end_count: classicEnds.length,
      classic_users: new Set(classicStarts.map((row) => row.uk)).size,
      avg_classic_score: avg(scores),
      avg_classic_duration_ms: avg(durations),
      classic_new_best_count: bestScoreRuns.total,
      classic_avg_steps_new_best: bestScoreRuns.avg_steps,
      level_select_count: rows.filter((row) => row.event_name === 'level_select').length,
      prop_request_count: rows.filter((row) => row.event_name === 'prop_request').length,
      prop_use_count: rows.filter((row) => row.event_name === 'prop_use').length,
      tutorial_step_count: rows.filter((row) => row.event_name === 'tutorial_step').length,
      computed_at: Date.now(),
    },
    mode_entries: buildModeEntries(rows),
    prop_usage: buildPropUsage(rows),
    tutorial_steps: buildTutorialSteps(rows),
    best_score_runs: bestScoreRuns,
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

/**
 * 经典模式「玩家刷新历史最高分」事件聚合。
 *
 * - 数据点：classic_end / classic_quit 里 params.is_new_best === true 的记录。
 * - 每条数据点 = (用户, score, steps_used)；同一玩家随着进步多次刷新最高分都算独立样本，
 *   关卡设计想看的就是「达到 X 分需要 Y 步」的完整成长曲线。
 * - 分数段分桶：粗对应「新手 / 上手 / 熟练 / 进阶 / 高手 / 顶尖」六档，
 *   每档输出平均步数 + 中位数步数，关卡步数预算可以直接取中位数。
 */
function buildBestScoreRuns(rows: AnalyticsRow[]): BestScoreRunsSummary {
  type Sample = { score: number; steps_used: number; user_key: string };
  const samples: Sample[] = [];
  for (const row of rows) {
    if (row.event_name !== 'classic_end' && row.event_name !== 'classic_quit') continue;
    if (!boolParam(row, 'is_new_best')) continue;
    const score = numParam(row, 'score');
    const steps = numParam(row, 'steps_used');
    if (score <= 0 || steps <= 0) continue; // 0/负值视作脏数据丢弃
    samples.push({ score, steps_used: steps, user_key: row.uk || '' });
  }
  samples.sort((a, b) => a.score - b.score);

  const allSteps = samples.map((s) => s.steps_used);
  const allScores = samples.map((s) => s.score);
  const total = samples.length;

  const ranges: Array<{ label: string; min: number; max: number }> = [
    { label: '0-100', min: 0, max: 100 },
    { label: '100-300', min: 100, max: 300 },
    { label: '300-600', min: 300, max: 600 },
    { label: '600-1000', min: 600, max: 1000 },
    { label: '1000-2000', min: 1000, max: 2000 },
    { label: '2000-5000', min: 2000, max: 5000 },
    { label: '5000+', min: 5000, max: Number.POSITIVE_INFINITY },
  ];

  const buckets: BestScoreRunBucket[] = ranges.map((r) => {
    const bucketSamples = samples.filter((s) => s.score >= r.min && s.score < r.max);
    const steps = bucketSamples.map((s) => s.steps_used);
    const scoresInBucket = bucketSamples.map((s) => s.score);
    const users = new Set(bucketSamples.map((s) => s.user_key).filter(Boolean));
    return {
      range_label: r.label,
      score_min: r.min,
      score_max: r.max,
      count: bucketSamples.length,
      unique_users: users.size,
      avg_steps: avg(steps),
      median_steps: median(steps),
      avg_score: avg(scoresInBucket),
    };
  });

  return {
    total,
    unique_users: new Set(samples.map((s) => s.user_key).filter(Boolean)).size,
    avg_steps: avg(allSteps),
    median_steps: median(allSteps),
    avg_score: avg(allScores),
    samples,
    buckets,
  };
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

/** is_new_best 这类布尔字段，兼容 SDK 上报成 true / 'true' / 1 / '1' 的多种格式。 */
function boolParam(row: AnalyticsRow, key: string): boolean {
  const value = paramsOf(row)[key];
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }
  return false;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const raw = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.round(raw * 100) / 100;
}

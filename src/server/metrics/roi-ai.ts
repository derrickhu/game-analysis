import { getLtvOverview, toLocalDateKey } from './ltv';
import { getBusinessRoiDecision, getBusinessRoiOverview } from './roi';

export interface RoiAiAnalysisResult {
  game_key: string;
  model: string;
  generated_at: number;
  analysis: string;
  input_summary: {
    from_date: string;
    to_date: string;
    decision_date: string;
    roi_rows: number;
    ltv_cohorts: number;
  };
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function buildPrompt(input: {
  gameKey: string;
  baselineDays: number;
  decision: Awaited<ReturnType<typeof getBusinessRoiDecision>>;
  roiOverview: Awaited<ReturnType<typeof getBusinessRoiOverview>>;
  ltvOverview: Awaited<ReturnType<typeof getLtvOverview>>;
}): string {
  // 最近 ROI 行截断量与 baselineDays 一致，避免选了 14/30 天基线却只送 7 天数据导致 AI 输出错位。
  // 上限 30 控制 prompt 长度，保留与 DeepSeek 超时口径匹配的安全余量。
  const recentDays = Math.max(7, Math.min(30, input.baselineDays));
  const recentRows = input.roiOverview.rows
    .slice()
    .sort((a, b) => a.date_key.localeCompare(b.date_key))
    .slice(-recentDays)
    .map((row) => ({
      date: row.date_key,
      spend: row.spend_cny,
      realRevenue: row.wechat_ad_revenue_cny,
      newUsers: row.game_new_users,
      cpi: row.cpi_cny,
      d0Roi: row.d0_roi,
      d30ProjectedLtv: row.d30_projected_ltv_cny,
      d30ProjectedRoi: row.d30_projected_roi,
      status: row.data_status_label,
    }));
  const cohorts = input.ltvOverview.cohorts.map((cohort) => ({
    cohortDate: cohort.cohort_date,
    cohortSize: cohort.cohort_size,
    observedDays: cohort.observed_days,
    ltv: cohort.ltv,
    retention: cohort.retention,
    observedRevenue: cohort.revenue.observed_cny,
    projectedD30Revenue: cohort.revenue.projected_d30_cny,
  }));
  const decision = {
    conclusion: input.decision.conclusion,
    action: input.decision.action_label,
    confidence: input.decision.confidence,
    diagnostics: input.decision.diagnostics,
    commercialDecision: input.decision.commercial_decision,
    budget: input.decision.budget_recommendation,
    monetizationFlow: input.decision.commercial_summary.monetization_flow,
    baseline: input.decision.baseline,
    reasons: input.decision.reasons.slice(0, 4),
    nextSteps: input.decision.next_steps.slice(0, 4),
  };

  return [
    '你是小游戏买量与商业化分析顾问。请只基于我提供的数据做分析，不要编造数据。',
    '目标：判断后续是否可能盈利、明天应该怎么投、如果不该加投应该优化买量还是优化游戏。',
    '重要约束：',
    '- D30 是预测值，不是已发生收入；请明确风险和置信度。',
    '- 当前投放只能调 oCPM 出价和日预算，不能直接控制 CPI。',
    '- 核心判断看周期平均，不要把某一天当成唯一结论。',
    '- 真实盈利优先看腾讯广告消耗、微信流量主真实收入/曝光、游戏新增、CPI、预测 LTV、留存和样本成熟度。',
    '- 游戏侧广告渗透、广告展示频次来自同一批 user_daily/flow analysis 数据，是判断“买量问题还是游戏变现问题”的关键。',
    '- 输出中文，结论要可执行，必须包含预算建议、oCPM 建议、止损线、观察指标，以及优先优化买量还是优化游戏。',
    '',
    '请控制在 220 字以内，禁止输出长篇报告，禁止输出 Markdown 标题，按以下固定结构输出：',
    '结论：一句话说明继续投/降预算/暂停/先优化游戏。',
    '原因：最多 3 条，每条必须带关键数字。',
    '动作：最多 3 条，必须包含预算或止损 CPI 建议。',
    '',
    `游戏：${input.gameKey}`,
    `系统规则决策：${compactJson(decision)}`,
    `最近 ROI 真实录入与派生指标：${compactJson({ summary: input.roiOverview.summary, rows: recentRows })}`,
    `LTV 与真实留存 cohort 摘要：${compactJson({ summary: input.ltvOverview.summary, cohorts })}`,
  ].join('\n');
}

function deepSeekTimeoutMs(): number {
  return Math.max(10_000, Math.min(180_000, Number(process.env.DEEPSEEK_TIMEOUT_MS) || 60_000));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`DeepSeek 请求超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    }),
  ]);
}

async function callDeepSeek(prompt: string): Promise<{ model: string; content: string }> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY 环境变量');
  }
  const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  const timeoutMs = deepSeekTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是严谨的小游戏 ROI、LTV、买量投放分析助手。' },
          { role: 'user', content: prompt },
        ],
        stream: false,
        reasoning_effort: 'low',
        max_tokens: 420,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`DeepSeek 请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek 请求失败: ${res.status} ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('DeepSeek 返回内容为空');
  return { model, content };
}

export async function analyzeRoiWithDeepSeek(
  gameKey: string,
  options: { baselineDays?: number; maturityDay?: 3 | 7 } = {},
): Promise<RoiAiAnalysisResult> {
  const decisionDate = toLocalDateKey(Date.now());
  const baselineDays = Math.max(3, Math.min(30, Number(options.baselineDays) || 7));
  const maturityDay = options.maturityDay || 3;
  const fromDate = addDays(decisionDate, -baselineDays);
  const toDate = addDays(decisionDate, -1);
  const [decision, roiOverview, ltvOverview] = await Promise.all([
    getBusinessRoiDecision(gameKey, { targetDate: decisionDate, baselineDays, maturityDay }),
    getBusinessRoiOverview(gameKey, fromDate, toDate),
    getLtvOverview(gameKey, fromDate, toDate),
  ]);
  const prompt = buildPrompt({ gameKey, baselineDays, decision, roiOverview, ltvOverview });
  const ai = await withTimeout(callDeepSeek(prompt), deepSeekTimeoutMs());
  return {
    game_key: gameKey,
    model: ai.model,
    generated_at: Date.now(),
    analysis: ai.content,
    input_summary: {
      from_date: fromDate,
      to_date: toDate,
      decision_date: decisionDate,
      roi_rows: roiOverview.rows.length,
      ltv_cohorts: ltvOverview.cohorts.length,
    },
  };
}

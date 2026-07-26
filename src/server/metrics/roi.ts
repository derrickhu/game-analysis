import {
  deleteBusinessDailyInput,
  listBusinessDailyInputs,
  listCohortLtvRows,
  listUserDailyRows,
  upsertBusinessDailyInput,
  type BusinessDailyInputDraft,
  type BusinessDailyInputRow,
  type CohortLtvDailyRow,
  type UserDailyRow,
} from '../ltv-db';
import { buildCohortLtvRows, listPlatformUserKeys } from './ltv';
import { isPlatformFilterActive } from './platform-filter';

async function loadUserDailyRows(gameKey: string, platform?: string): Promise<UserDailyRow[]> {
  const rows = await listUserDailyRows(gameKey);
  if (!isPlatformFilterActive(platform)) return rows;
  const platformUserKeys = await listPlatformUserKeys(gameKey, platform as string);
  return rows.filter((r) => platformUserKeys.has(r.user_key));
}

async function loadCohortLtvRows(
  gameKey: string,
  userDailyRows: UserDailyRow[],
  fromDate: string,
  toDate: string,
  platform?: string,
): Promise<CohortLtvDailyRow[]> {
  if (!isPlatformFilterActive(platform)) return listCohortLtvRows(gameKey, fromDate, toDate);
  // 预聚合表 analytics_cohort_ltv_daily 不区分平台；选定具体平台时基于该平台的 user_daily 子集
  // 在内存里重算 cohort LTV，不落库。
  return buildCohortLtvRows(gameKey, userDailyRows, fromDate, toDate);
}

export interface BusinessRoiRow {
  id: number;
  game_key: string;
  date_key: string;
  spend_cny: number;
  wechat_clicks: number;
  wechat_ad_revenue_cny: number;
  wechat_ad_impressions: number;
  note: string;
  game_new_users: number;
  estimated_ad_revenue_cny: number;
  estimated_revenue_diff_cny: number;
  cpc_cny: number | null;
  cpi_cny: number | null;
  click_to_new_user_rate: number | null;
  actual_ecpm_cny: number | null;
  d0_margin_cny: number;
  d0_roi: number | null;
  d3_ltv_cny: number | null;
  d3_roi: number | null;
  d7_ltv_cny: number | null;
  d7_roi: number | null;
  d30_projected_ltv_cny: number | null;
  d30_projected_roi: number | null;
  d30_projected_margin_cny: number | null;
  break_even_cpi_cny: number | null;
  data_status: 'ok' | 'no_tracking' | 'small_sample' | 'conversion_abnormal' | 'immature_ltv';
  data_status_label: string;
  updated_at: number;
}

export interface BusinessRoiResult {
  game_key: string;
  from_date: string;
  to_date: string;
  rows: BusinessRoiRow[];
  summary: {
    total_spend_cny: number;
    total_wechat_revenue_cny: number;
    total_wechat_clicks: number;
    total_wechat_impressions: number;
    total_game_new_users: number;
    avg_cpi_cny: number | null;
    avg_cpc_cny: number | null;
    actual_ecpm_cny: number | null;
    total_d0_margin_cny: number;
    d0_roi: number | null;
  };
}

export type RoiDecisionAction =
  | 'scale'
  | 'scale_cautiously'
  | 'observe'
  | 'reduce_budget'
  | 'pause'
  | 'optimize_game'
  | 'fix_tracking';

export interface BusinessRoiDecisionResult {
  game_key: string;
  target_date: string;
  baseline_from_date: string;
  baseline_to_date: string;
  maturity_day: 3 | 7;
  target: BusinessRoiRow | null;
  action: RoiDecisionAction;
  action_label: string;
  confidence: 'high' | 'medium' | 'low';
  conclusion: string;
  reasons: string[];
  next_steps: string[];
  diagnostics: {
    issue_type: 'traffic' | 'game_monetization' | 'data_quality' | 'immature' | 'healthy' | 'mixed';
    issue_label: string;
  };
  commercial_decision: {
    headline: string;
    decision: 'scale' | 'hold' | 'reduce' | 'pause' | 'optimize_game' | 'wait_data';
    primary_problem: 'buying_cost' | 'monetization' | 'retention' | 'data_maturity' | 'tracking';
    confidence: 'high' | 'medium' | 'low';
    core_metrics: {
      total_spend_cny: number;
      total_new_users: number;
      avg_cpi_cny: number | null;
      projected_d30_ltv_cny: number | null;
      projected_d30_roas: number | null;
      d0_roas: number | null;
      d1_retention: number | null;
      d7_retention: number | null;
      sample_days: number;
      d30_roas_basis: 'mature' | 'early' | 'insufficient';
    };
    key_reasons: string[];
    actions: string[];
  };
  budget_recommendation: {
    reference_spend_cny: number;
    latest_recorded_spend_cny: number;
    baseline_avg_spend_cny: number;
    recommended_min_cny: number;
    recommended_max_cny: number;
    expected_d30_revenue_cny: number | null;
    expected_d30_profit_cny: number | null;
    target_cpi_cny: number | null;
    hard_stop_cpi_cny: number | null;
    break_even_cpi_cny: number | null;
    note: string;
  };
  commercial_summary: {
    verdict_level: 'healthy' | 'risky' | 'loss' | 'unknown';
    verdict_label: string;
    total_spend_cny: number;
    total_real_revenue_cny: number;
    total_new_users: number;
    d0_roi: number | null;
    d0_margin_cny: number;
    avg_cpi_cny: number | null;
    early_sample_days: number;
    early_d30_ltv_cny: number | null;
    early_d30_roi: number | null;
    d1_retention: number | null;
    d7_retention: number | null;
    monetization_flow: {
      active_user_days: number;
      ad_user_days: number;
      ad_penetration_rate: number | null;
      ad_show_cnt: number;
      ad_show_per_ad_user: number | null;
      ad_show_per_active_user: number | null;
      fill_rate: number | null;
      actual_ecpm_cny: number | null;
    };
    key_findings: string[];
    optimization_suggestions: string[];
  };
  baseline: {
    valid_sample_days: number;
    excluded_sample_days: number;
    total_spend_cny: number;
    total_new_users: number;
    avg_cpi_cny: number | null;
    weighted_d30_ltv_cny: number | null;
    predicted_d30_roi: number | null;
    predicted_margin_per_user_cny: number | null;
  };
  samples: Array<{
    date_key: string;
    included: boolean;
    reason: string;
    game_new_users: number;
    cpi_cny: number | null;
    d30_projected_ltv_cny: number | null;
    d30_projected_roi: number | null;
    data_status_label: string;
  }>;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round4(numerator / denominator) : null;
}

function dateKeyToStartTs(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00`).getTime();
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function sumUserDailyByDate(rows: UserDailyRow[]): Map<string, { newUsers: number; estimatedRevenue: number }> {
  const map = new Map<string, { newUsers: number; estimatedRevenue: number }>();
  for (const row of rows) {
    const cur = map.get(row.date_key) || { newUsers: 0, estimatedRevenue: 0 };
    if (Number(row.is_new_user) === 1) cur.newUsers += 1;
    cur.estimatedRevenue += Number(row.ad_revenue_estimated_cny || 0);
    map.set(row.date_key, cur);
  }
  return map;
}

function buildLtvProjectionMap(rows: CohortLtvDailyRow[]): Map<string, number | null> {
  const byDate = new Map<string, CohortLtvDailyRow[]>();
  for (const row of rows) {
    const list = byDate.get(row.cohort_date) || [];
    list.push(row);
    byDate.set(row.cohort_date, list);
  }

  const out = new Map<string, number | null>();
  for (const [date, list] of byDate.entries()) {
    // 与 ltv.ts/projectFromRows 保持同一口径：只承认 is_complete_day=1 的 D3/D7/D30，
    // 避免 cohort 刚满 D7 当天就被取还在累计中的部分值乘 1.9，造成 D30 LTV 低估、CPI 看似不达标。
    const byAge = new Map<number, number>();
    for (const r of list) {
      if (Number(r.is_complete_day) === 1) byAge.set(Number(r.age_day), Number(r.ltv_cny));
    }
    const d30 = byAge.get(30);
    const d7 = byAge.get(7);
    const d3 = byAge.get(3);
    if (d30 !== undefined) out.set(date, round4(d30));
    else if (d7 !== undefined) out.set(date, round4(d7 * 1.9));
    else if (d3 !== undefined) out.set(date, round4(d3 * 3.2));
    else out.set(date, null);
  }
  return out;
}

function buildLtvAgeMap(rows: CohortLtvDailyRow[], ageDay: number): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const row of rows) {
    if (Number(row.age_day) !== ageDay || Number(row.is_complete_day) !== 1) continue;
    out.set(row.cohort_date, round4(Number(row.ltv_cny || 0)));
  }
  return out;
}

function buildCompleteObservedAgeMap(rows: CohortLtvDailyRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    if (Number(row.is_complete_day) !== 1) continue;
    map.set(row.cohort_date, Math.max(map.get(row.cohort_date) || 0, Number(row.age_day)));
  }
  return map;
}

function weightedRetention(rows: CohortLtvDailyRow[], ageDay: number): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const row of rows) {
    if (Number(row.age_day) !== ageDay || Number(row.is_complete_day) !== 1) continue;
    const size = Number(row.cohort_size || 0);
    numerator += Number(row.retention_rate || 0) * size;
    denominator += size;
  }
  return denominator > 0 ? round4(numerator / denominator) : null;
}

function buildMonetizationFlow(input: {
  userDailyRows: UserDailyRow[];
  fromDate: string;
  toDate: string;
  realRevenueCny: number;
  realImpressions: number;
}): BusinessRoiDecisionResult['commercial_summary']['monetization_flow'] {
  const rows = input.userDailyRows.filter((row) => row.date_key >= input.fromDate && row.date_key <= input.toDate);
  const activeUserDays = rows.filter((row) => Number(row.is_active) === 1).length;
  const adUserDays = rows.filter((row) => Number(row.ad_show_cnt || 0) > 0).length;
  const adShowCnt = rows.reduce((sum, row) => sum + Number(row.ad_show_cnt || 0), 0);
  const adRequestCnt = rows.reduce((sum, row) => sum + Number(row.ad_request_cnt || 0), 0);

  return {
    active_user_days: activeUserDays,
    ad_user_days: adUserDays,
    ad_penetration_rate: ratio(adUserDays, activeUserDays),
    ad_show_cnt: adShowCnt,
    ad_show_per_ad_user: ratio(adShowCnt, adUserDays),
    ad_show_per_active_user: ratio(adShowCnt, activeUserDays),
    fill_rate: ratio(adShowCnt, adRequestCnt),
    actual_ecpm_cny: input.realImpressions > 0 ? round2((input.realRevenueCny / input.realImpressions) * 1000) : null,
  };
}

function buildCommercialSummary(input: {
  rowsAsc: BusinessRoiRow[];
  earlyRows: BusinessRoiRow[];
  ltvRows: CohortLtvDailyRow[];
  userDailyRows: UserDailyRow[];
  targetDate: string;
  fromDate: string;
}): BusinessRoiDecisionResult['commercial_summary'] {
  const recordedRows = input.rowsAsc.filter((row) => row.date_key < input.targetDate && row.spend_cny > 0);
  const totalSpend = recordedRows.reduce((sum, row) => sum + row.spend_cny, 0);
  const totalRevenue = recordedRows.reduce((sum, row) => sum + row.wechat_ad_revenue_cny, 0);
  const totalImpressions = recordedRows.reduce((sum, row) => sum + row.wechat_ad_impressions, 0);
  const totalNewUsers = recordedRows.reduce((sum, row) => sum + row.game_new_users, 0);
  const d0Roi = ratio(totalRevenue, totalSpend);
  const avgCpi = ratio(totalSpend, totalNewUsers);
  const monetizationFlow = buildMonetizationFlow({
    userDailyRows: input.userDailyRows,
    fromDate: input.fromDate,
    toDate: addDays(input.targetDate, -1),
    realRevenueCny: totalRevenue,
    realImpressions: totalImpressions,
  });
  const earlyProjectedRevenue = input.earlyRows.reduce(
    (sum, row) => sum + (row.d30_projected_ltv_cny || 0) * row.game_new_users,
    0,
  );
  const earlySpend = input.earlyRows.reduce((sum, row) => sum + row.spend_cny, 0);
  const earlyNewUsers = input.earlyRows.reduce((sum, row) => sum + row.game_new_users, 0);
  const earlyD30Ltv = ratio(earlyProjectedRevenue, earlyNewUsers);
  const earlyD30Roi = ratio(earlyProjectedRevenue, earlySpend);
  const d1Retention = weightedRetention(input.ltvRows, 1);
  const d7Retention = weightedRetention(input.ltvRows, 7);

  let verdictLevel: BusinessRoiDecisionResult['commercial_summary']['verdict_level'] = 'unknown';
  let verdictLabel = '样本仍在成熟，先按早期指标保守判断';
  if (earlyD30Roi !== null) {
    if (earlyD30Roi >= 1.3) {
      verdictLevel = d0Roi !== null && d0Roi < 0.2 ? 'risky' : 'healthy';
      verdictLabel = verdictLevel === 'healthy' ? '早期预测有盈利空间' : '长期可能回本，但首日回收偏弱';
    } else if (earlyD30Roi >= 1) {
      verdictLevel = 'risky';
      verdictLabel = '接近回本但安全边际不足';
    } else {
      verdictLevel = 'loss';
      verdictLabel = '按当前早期数据预测偏亏损';
    }
  } else if (d0Roi !== null) {
    verdictLevel = d0Roi >= 0.3 ? 'risky' : 'unknown';
    verdictLabel = d0Roi >= 0.3 ? '首日回收尚可，但缺少 LTV 成熟样本' : '首日回收偏低，需等待 LTV 成熟';
  }

  const keyFindings = [
    `近 ${recordedRows.length} 个录入日总花费 ${round2(totalSpend)} 元，D0 真实收入 ${round2(totalRevenue)} 元，D0 ROI ${d0Roi !== null ? `${(d0Roi * 100).toFixed(1)}%` : '-' }。`,
    `累计新增 ${totalNewUsers} 人，平均 CPI ${avgCpi !== null ? `${avgCpi.toFixed(4)} 元` : '-' }。`,
  ];
  if (earlyD30Roi !== null && earlyD30Ltv !== null) {
    keyFindings.push(`已有 ${input.earlyRows.length} 天达到 D3+ 早期 LTV，预测 D30 LTV ${earlyD30Ltv.toFixed(4)} 元，预测 D30 ROI ${(earlyD30Roi * 100).toFixed(1)}%。`);
  } else {
    keyFindings.push('暂时缺少 D3+ 早期 LTV 样本，不能可靠估计 D30 回收。');
  }
  if (d1Retention !== null) {
    keyFindings.push(`新增 D1 次留约 ${(d1Retention * 100).toFixed(1)}%，D7 留存${d7Retention !== null ? `约 ${(d7Retention * 100).toFixed(1)}%` : '仍在成熟中'}。`);
  }
  if (monetizationFlow.ad_penetration_rate !== null) {
    keyFindings.push(
      `广告渗透 ${(monetizationFlow.ad_penetration_rate * 100).toFixed(1)}%，看广告用户人均 ${monetizationFlow.ad_show_per_ad_user?.toFixed(2) ?? '-'} 次，真实 eCPM ${monetizationFlow.actual_ecpm_cny?.toFixed(2) ?? '-'} 元。`,
    );
  }

  const optimizationSuggestions: string[] = [];
  if (avgCpi !== null && earlyD30Ltv !== null && avgCpi > earlyD30Ltv) {
    optimizationSuggestions.push(`买量止损：当前平均 CPI ${avgCpi.toFixed(4)} 元高于预测 D30 LTV ${earlyD30Ltv.toFixed(4)} 元，应压低 oCPM/素材成本，不建议放量。`);
  }
  if (d0Roi !== null && d0Roi < 0.25) {
    optimizationSuggestions.push('首日回收偏弱：优先优化新手期广告触发、激励点位价值、插屏频控和首局目标，让 D0 ROI 先接近 25%-35%。');
  }
  if (monetizationFlow.ad_penetration_rate !== null && monetizationFlow.ad_penetration_rate < 0.3) {
    optimizationSuggestions.push('广告渗透偏低：优先增加新手期自然广告触点和激励入口可见性，先让更多活跃用户看到至少 1 次广告。');
  } else if (monetizationFlow.ad_show_per_ad_user !== null && monetizationFlow.ad_show_per_ad_user < 2) {
    optimizationSuggestions.push('看广告用户频次偏低：优先优化激励价值、复活/翻倍/道具入口和关卡节奏，提高人均展示次数。');
  }
  if (d1Retention !== null && d1Retention < 0.08) {
    optimizationSuggestions.push('新增次留偏低：优先优化前 3 分钟引导、首局失败/复活体验、目标反馈和第二天回访理由，否则 D7/D30 回收空间有限。');
  }
  optimizationSuggestions.push('投放动作：明天先保持小预算，不加量；只在 CPI 连续低于预测 D30 LTV 且 D1/D3 留存不下降时再逐步加 20%-30%。');

  return {
    verdict_level: verdictLevel,
    verdict_label: verdictLabel,
    total_spend_cny: round2(totalSpend),
    total_real_revenue_cny: round2(totalRevenue),
    total_new_users: totalNewUsers,
    d0_roi: d0Roi,
    d0_margin_cny: round2(totalRevenue - totalSpend),
    avg_cpi_cny: avgCpi,
    early_sample_days: input.earlyRows.length,
    early_d30_ltv_cny: earlyD30Ltv,
    early_d30_roi: earlyD30Roi,
    d1_retention: d1Retention,
    d7_retention: d7Retention,
    monetization_flow: monetizationFlow,
    key_findings: keyFindings,
    optimization_suggestions: optimizationSuggestions,
  };
}

function getRowStatus(row: {
  game_new_users: number;
  wechat_clicks: number;
  click_to_new_user_rate: number | null;
  d30_projected_ltv_cny: number | null;
}): Pick<BusinessRoiRow, 'data_status' | 'data_status_label'> {
  if (row.game_new_users <= 0) return { data_status: 'no_tracking', data_status_label: '无游戏打点' };
  if (row.game_new_users < 100) return { data_status: 'small_sample', data_status_label: '样本过小' };
  if (
    row.wechat_clicks > 0 &&
    row.click_to_new_user_rate !== null &&
    (row.click_to_new_user_rate < 0.2 || row.click_to_new_user_rate > 1.2)
  ) {
    return { data_status: 'conversion_abnormal', data_status_label: '转化异常' };
  }
  if (row.d30_projected_ltv_cny === null) return { data_status: 'immature_ltv', data_status_label: '数据未成熟' };
  return { data_status: 'ok', data_status_label: '可用于判断' };
}

function actionLabel(action: RoiDecisionAction): string {
  const labels: Record<RoiDecisionAction, string> = {
    scale: '可以加投',
    scale_cautiously: '小幅放量',
    observe: '继续观察',
    reduce_budget: '降预算',
    pause: '暂停投放',
    optimize_game: '先优化游戏/变现',
    fix_tracking: '先修数据口径',
  };
  return labels[action];
}

function buildBudgetRecommendation(input: {
  action: RoiDecisionAction;
  confidence: BusinessRoiDecisionResult['confidence'];
  rowsAsc: BusinessRoiRow[];
  validRows: BusinessRoiRow[];
  predictedD30Roi: number | null;
  weightedD30Ltv: number | null;
}): BusinessRoiDecisionResult['budget_recommendation'] {
  const latestSpend = [...input.rowsAsc].reverse().find((row) => row.spend_cny > 0)?.spend_cny || 0;
  const baselineAvgSpend =
    input.validRows.length > 0
      ? round2(input.validRows.reduce((sum, row) => sum + row.spend_cny, 0) / input.validRows.length)
      : 0;
  const referenceSpend = round2(latestSpend || baselineAvgSpend);
  const targetCpi = input.weightedD30Ltv !== null ? round4(input.weightedD30Ltv * 0.8) : null;
  const hardStopCpi = input.weightedD30Ltv !== null ? round4(input.weightedD30Ltv) : null;

  let minBudget = 0;
  let maxBudget = 0;
  let note = '没有足够成熟样本，建议只保留小预算观察。';

  if (input.action === 'scale' || input.action === 'scale_cautiously') {
    const maxMultiplier = input.confidence === 'high' ? 1.5 : 1.3;
    minBudget = referenceSpend;
    maxBudget = referenceSpend * maxMultiplier;
    note = `按最近投放金额做阶梯放量，先投 ${round2(minBudget)}-${round2(maxBudget)} 元；只有 CPI 低于目标 CPI 且次日数据正常，才继续加。`;
  } else if (input.action === 'observe') {
    minBudget = referenceSpend * 0.7;
    maxBudget = referenceSpend;
    note = `不建议加预算，明天控制在 ${round2(minBudget)}-${round2(maxBudget)} 元观察，等 D7 或更多真实收入确认。`;
  } else if (input.action === 'reduce_budget' || input.action === 'optimize_game') {
    minBudget = 0;
    maxBudget = referenceSpend * 0.5;
    note = `不建议放量，明天最多保留 ${round2(maxBudget)} 元以内验证；先优化买量成本或游戏变现。`;
  } else {
    minBudget = 0;
    maxBudget = 0;
    note = '先修数据口径，不建议继续投放判断。';
  }

  const recommendedMax = round2(maxBudget);
  return {
    reference_spend_cny: referenceSpend,
    latest_recorded_spend_cny: round2(latestSpend),
    baseline_avg_spend_cny: baselineAvgSpend,
    recommended_min_cny: round2(minBudget),
    recommended_max_cny: recommendedMax,
    expected_d30_revenue_cny:
      input.predictedD30Roi !== null && recommendedMax > 0 ? round2(recommendedMax * input.predictedD30Roi) : null,
    expected_d30_profit_cny:
      input.predictedD30Roi !== null && recommendedMax > 0 ? round2(recommendedMax * (input.predictedD30Roi - 1)) : null,
    target_cpi_cny: targetCpi,
    hard_stop_cpi_cny: hardStopCpi,
    break_even_cpi_cny: input.weightedD30Ltv,
    note,
  };
}

function mapCommercialDecision(input: {
  action: RoiDecisionAction;
  issueType: BusinessRoiDecisionResult['diagnostics']['issue_type'];
  confidence: BusinessRoiDecisionResult['confidence'];
  reasons: string[];
  nextSteps: string[];
  budgetRecommendation: BusinessRoiDecisionResult['budget_recommendation'];
  commercialSummary: BusinessRoiDecisionResult['commercial_summary'];
  baseline: BusinessRoiDecisionResult['baseline'];
}): BusinessRoiDecisionResult['commercial_decision'] {
  const decisionMap: Record<RoiDecisionAction, BusinessRoiDecisionResult['commercial_decision']['decision']> = {
    scale: 'scale',
    scale_cautiously: 'scale',
    observe: 'hold',
    reduce_budget: 'reduce',
    pause: 'pause',
    optimize_game: 'optimize_game',
    fix_tracking: 'wait_data',
  };
  const problemMap: Record<
    BusinessRoiDecisionResult['diagnostics']['issue_type'],
    BusinessRoiDecisionResult['commercial_decision']['primary_problem']
  > = {
    traffic: 'buying_cost',
    game_monetization: 'monetization',
    data_quality: 'tracking',
    immature: 'data_maturity',
    healthy: 'buying_cost',
    mixed: 'data_maturity',
  };

  const keyReasons = [
    ...input.reasons,
    ...input.commercialSummary.key_findings,
  ]
    .filter(Boolean)
    .slice(0, 3);
  const actions = [
    input.budgetRecommendation.note,
    ...input.nextSteps,
    ...input.commercialSummary.optimization_suggestions,
  ]
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .slice(0, 3);

  return {
    headline: `${actionLabel(input.action)}：${keyReasons[0] || '当前周期样本不足，先保守观察'}`,
    decision: decisionMap[input.action],
    primary_problem: problemMap[input.issueType],
    confidence: input.confidence,
    core_metrics: {
      total_spend_cny: input.commercialSummary.total_spend_cny,
      total_new_users: input.commercialSummary.total_new_users,
      avg_cpi_cny: input.commercialSummary.avg_cpi_cny ?? input.baseline.avg_cpi_cny,
      projected_d30_ltv_cny: input.baseline.weighted_d30_ltv_cny ?? input.commercialSummary.early_d30_ltv_cny,
      projected_d30_roas: input.baseline.predicted_d30_roi ?? input.commercialSummary.early_d30_roi,
      d0_roas: input.commercialSummary.d0_roi,
      d1_retention: input.commercialSummary.d1_retention,
      d7_retention: input.commercialSummary.d7_retention,
      sample_days: input.baseline.valid_sample_days || input.commercialSummary.early_sample_days,
      d30_roas_basis:
        input.baseline.predicted_d30_roi !== null
          ? 'mature'
          : input.commercialSummary.early_d30_roi !== null
            ? 'early'
            : 'insufficient',
    },
    key_reasons: keyReasons,
    actions,
  };
}

export async function saveBusinessDailyInput(input: BusinessDailyInputDraft): Promise<BusinessDailyInputRow> {
  return upsertBusinessDailyInput(input);
}

export async function removeBusinessDailyInput(gameKey: string, dateKey: string): Promise<number> {
  return deleteBusinessDailyInput(gameKey, dateKey);
}

export async function getBusinessRoiOverview(
  gameKey: string,
  fromDate: string,
  toDate: string,
  platform?: string,
): Promise<BusinessRoiResult> {
  const [inputs, userDailyRows] = await Promise.all([
    listBusinessDailyInputs(gameKey, fromDate, toDate),
    loadUserDailyRows(gameKey, platform),
  ]);
  const ltvRows = await loadCohortLtvRows(gameKey, userDailyRows, fromDate, toDate, platform);
  const userDailyByDate = sumUserDailyByDate(userDailyRows);
  const ltvProjectionByDate = buildLtvProjectionMap(ltvRows);
  const d3LtvByDate = buildLtvAgeMap(ltvRows, 3);
  const d7LtvByDate = buildLtvAgeMap(ltvRows, 7);

  const rows: BusinessRoiRow[] = inputs.map((input) => {
    const daily = userDailyByDate.get(input.date_key) || { newUsers: 0, estimatedRevenue: 0 };
    const spend = Number(input.spend_cny || 0);
    const clicks = Number(input.wechat_clicks || 0);
    const revenue = Number(input.wechat_ad_revenue_cny || 0);
    const impressions = Number(input.wechat_ad_impressions || 0);
    const gameNewUsers = Number(daily.newUsers || 0);
    const estimatedRevenue = round2(Number(daily.estimatedRevenue || 0));
    const cpi = ratio(spend, gameNewUsers);
    const d3Ltv = d3LtvByDate.get(input.date_key) ?? null;
    const d7Ltv = d7LtvByDate.get(input.date_key) ?? null;
    const d30Ltv = ltvProjectionByDate.get(input.date_key) ?? null;
    return {
      id: Number(input.id),
      game_key: input.game_key,
      date_key: input.date_key,
      spend_cny: spend,
      wechat_clicks: clicks,
      wechat_ad_revenue_cny: revenue,
      wechat_ad_impressions: impressions,
      note: input.note || '',
      game_new_users: gameNewUsers,
      estimated_ad_revenue_cny: estimatedRevenue,
      estimated_revenue_diff_cny: round2(estimatedRevenue - revenue),
      cpc_cny: ratio(spend, clicks),
      cpi_cny: cpi,
      click_to_new_user_rate: ratio(gameNewUsers, clicks),
      actual_ecpm_cny: impressions > 0 ? round2((revenue / impressions) * 1000) : null,
      d0_margin_cny: round2(revenue - spend),
      d0_roi: ratio(revenue, spend),
      d3_ltv_cny: d3Ltv,
      d3_roi: d3Ltv !== null && cpi !== null && cpi > 0 ? round4(d3Ltv / cpi) : null,
      d7_ltv_cny: d7Ltv,
      d7_roi: d7Ltv !== null && cpi !== null && cpi > 0 ? round4(d7Ltv / cpi) : null,
      d30_projected_ltv_cny: d30Ltv,
      d30_projected_roi: d30Ltv !== null && cpi !== null && cpi > 0 ? round4(d30Ltv / cpi) : null,
      d30_projected_margin_cny: d30Ltv !== null && cpi !== null ? round4(d30Ltv - cpi) : null,
      break_even_cpi_cny: d30Ltv,
      ...getRowStatus({
        game_new_users: gameNewUsers,
        wechat_clicks: clicks,
        click_to_new_user_rate: ratio(gameNewUsers, clicks),
        d30_projected_ltv_cny: d30Ltv,
      }),
      updated_at: Number(input.updated_at || 0),
    };
  });

  const totalSpend = rows.reduce((sum, row) => sum + row.spend_cny, 0);
  const totalRevenue = rows.reduce((sum, row) => sum + row.wechat_ad_revenue_cny, 0);
  const totalClicks = rows.reduce((sum, row) => sum + row.wechat_clicks, 0);
  const totalImpressions = rows.reduce((sum, row) => sum + row.wechat_ad_impressions, 0);
  const totalNewUsers = rows.reduce((sum, row) => sum + row.game_new_users, 0);

  return {
    game_key: gameKey,
    from_date: fromDate,
    to_date: toDate,
    rows,
    summary: {
      total_spend_cny: round2(totalSpend),
      total_wechat_revenue_cny: round2(totalRevenue),
      total_wechat_clicks: totalClicks,
      total_wechat_impressions: totalImpressions,
      total_game_new_users: totalNewUsers,
      avg_cpi_cny: ratio(totalSpend, totalNewUsers),
      avg_cpc_cny: ratio(totalSpend, totalClicks),
      actual_ecpm_cny: totalImpressions > 0 ? round2((totalRevenue / totalImpressions) * 1000) : null,
      total_d0_margin_cny: round2(totalRevenue - totalSpend),
      d0_roi: ratio(totalRevenue, totalSpend),
    },
  };
}

export async function getBusinessRoiDecision(
  gameKey: string,
  options: { targetDate: string; baselineDays?: number; maturityDay?: 3 | 7; platform?: string },
): Promise<BusinessRoiDecisionResult> {
  const targetDate = options.targetDate;
  const baselineDays = Math.max(3, Math.min(30, Number(options.baselineDays) || 7));
  const maturityDay = options.maturityDay || 3;
  const platform = options.platform;
  const baselineFromDate = addDays(targetDate, -baselineDays);
  const overview = await getBusinessRoiOverview(gameKey, baselineFromDate, targetDate, platform);
  const rowsAsc = [...overview.rows].sort((a, b) => dateKeyToStartTs(a.date_key) - dateKeyToStartTs(b.date_key));
  const userDailyRows = await loadUserDailyRows(gameKey, platform);
  const ltvRows = await loadCohortLtvRows(gameKey, userDailyRows, baselineFromDate, targetDate, platform);
  // 投放决策只能使用已完整结束的 D3/D7。比如 5/09 cohort 的 D7 是 5/16，
  // 如果 5/16 当天还没结束，就不能把它当作 D7 成熟样本。
  const completeObservedAgeByDate = buildCompleteObservedAgeMap(ltvRows);
  const target = rowsAsc.find((row) => row.date_key === targetDate) || null;

  const samples = rowsAsc
    .filter((row) => row.date_key < targetDate)
    .map((row) => {
      const observedAge = completeObservedAgeByDate.get(row.date_key) || 0;
      let included = row.data_status === 'ok' && observedAge >= maturityDay;
      let reason = '纳入基线';
      if (row.game_new_users <= 0) reason = '无游戏打点，无法计算 CPI';
      else if (row.game_new_users < 100) reason = '新增样本过小，容易误判';
      else if (row.click_to_new_user_rate !== null && (row.click_to_new_user_rate < 0.2 || row.click_to_new_user_rate > 1.2)) {
        reason = '点击转新增异常，疑似归因或口径问题';
      } else if (row.d30_projected_ltv_cny === null || observedAge < maturityDay) {
        reason = `LTV 未达到 D${maturityDay} 成熟度`;
      }
      if (reason !== '纳入基线') included = false;
      return {
        date_key: row.date_key,
        included,
        reason,
        game_new_users: row.game_new_users,
        cpi_cny: row.cpi_cny,
        d30_projected_ltv_cny: row.d30_projected_ltv_cny,
        d30_projected_roi: row.d30_projected_roi,
        data_status_label: row.data_status_label,
      };
    });

  const validRows = rowsAsc.filter((row) => samples.some((sample) => sample.date_key === row.date_key && sample.included));
  const totalSpend = validRows.reduce((sum, row) => sum + row.spend_cny, 0);
  const totalNewUsers = validRows.reduce((sum, row) => sum + row.game_new_users, 0);
  const projectedRevenue = validRows.reduce(
    (sum, row) => sum + (row.d30_projected_ltv_cny || 0) * row.game_new_users,
    0,
  );
  const avgCpi = ratio(totalSpend, totalNewUsers);
  const weightedD30Ltv = ratio(projectedRevenue, totalNewUsers);
  const predictedD30Roi = ratio(projectedRevenue, totalSpend);
  const predictedMarginPerUser =
    weightedD30Ltv !== null && avgCpi !== null ? round4(weightedD30Ltv - avgCpi) : null;
  const earlyRows = rowsAsc.filter((row) => {
    const observedAge = completeObservedAgeByDate.get(row.date_key) || 0;
    return (
      row.date_key < targetDate &&
      row.spend_cny > 0 &&
      row.game_new_users >= 100 &&
      row.d30_projected_ltv_cny !== null &&
      observedAge >= 3 &&
      row.data_status !== 'conversion_abnormal'
    );
  });
  const earlyProjectedRevenue = earlyRows.reduce(
    (sum, row) => sum + (row.d30_projected_ltv_cny || 0) * row.game_new_users,
    0,
  );
  const earlySpend = earlyRows.reduce((sum, row) => sum + row.spend_cny, 0);
  const earlyNewUsers = earlyRows.reduce((sum, row) => sum + row.game_new_users, 0);
  const earlyAvgCpi = ratio(earlySpend, earlyNewUsers);
  const earlyWeightedD30Ltv = ratio(earlyProjectedRevenue, earlyNewUsers);
  const earlyPredictedD30Roi = ratio(earlyProjectedRevenue, earlySpend);
  const commercialSummary = buildCommercialSummary({
    rowsAsc,
    earlyRows,
    ltvRows,
    userDailyRows,
    targetDate,
    fromDate: baselineFromDate,
  });

  const reasons: string[] = [];
  const nextSteps: string[] = [];
  let action: RoiDecisionAction = 'observe';
  let confidence: BusinessRoiDecisionResult['confidence'] = 'low';
  let issueType: BusinessRoiDecisionResult['diagnostics']['issue_type'] = 'immature';

  if (!target) {
    if (predictedD30Roi !== null && predictedD30Roi >= 1.3 && validRows.length >= 2) {
      action = 'scale_cautiously';
      confidence = validRows.length >= 3 ? 'medium' : 'low';
      issueType = 'healthy';
      reasons.push(`截至 ${addDays(targetDate, -1)} 的成熟基线预测 D30 ROI 为 ${(predictedD30Roi * 100).toFixed(1)}%，高于 130% 放量线。`);
      reasons.push(`基线 CPI ${avgCpi?.toFixed(4)} 元，低于基线 D30 LTV ${weightedD30Ltv?.toFixed(4)} 元。`);
      nextSteps.push('明天可以小幅放量，建议预算增加不超过 20%-30%，不要一次性大幅加投。');
      nextSteps.push(`继续补齐 ${addDays(targetDate, -1)} 之后的真实收入，等 D7 后再决定是否继续扩大。`);
    } else if (predictedD30Roi !== null && predictedD30Roi >= 1) {
      action = 'observe';
      confidence = 'medium';
      issueType = 'mixed';
      reasons.push(`截至 ${addDays(targetDate, -1)} 的成熟基线预测 D30 ROI 为 ${(predictedD30Roi * 100).toFixed(1)}%，能回本但安全边际不够。`);
      nextSteps.push('明天不建议加大投放，保持当前小预算继续观察。');
      nextSteps.push('优先看 D7 后 ROI 是否仍高于 130%，再决定是否放量。');
    } else if (predictedD30Roi !== null) {
      const flow = commercialSummary.monetization_flow;
      const monetizationWeak =
        (commercialSummary.d0_roi !== null && commercialSummary.d0_roi < 0.15) ||
        (flow.ad_penetration_rate !== null && flow.ad_penetration_rate < 0.25) ||
        (flow.ad_show_per_ad_user !== null && flow.ad_show_per_ad_user < 1.5);
      action = monetizationWeak ? 'optimize_game' : 'reduce_budget';
      confidence = 'medium';
      issueType = monetizationWeak ? 'game_monetization' : 'traffic';
      reasons.push(`截至 ${addDays(targetDate, -1)} 的成熟基线预测 D30 ROI 为 ${(predictedD30Roi * 100).toFixed(1)}%，低于回本线。`);
      nextSteps.push(
        monetizationWeak
          ? '当前更像游戏广告变现/广告触达不足，先优化广告渗透、频次和新手期广告价值，再考虑放量。'
          : '当前更像买量成本过高，先降预算，优化素材、定向和 oCPM 出价，把 CPI 压到预测 D30 LTV 以下。',
      );
    } else {
      action = 'observe';
      const flow = commercialSummary.monetization_flow;
      const flowWeak =
        (flow.ad_penetration_rate !== null && flow.ad_penetration_rate < 0.25) ||
        (flow.ad_show_per_ad_user !== null && flow.ad_show_per_ad_user < 1.5);
      issueType = commercialSummary.verdict_level === 'loss' ? (flowWeak ? 'game_monetization' : 'traffic') : 'immature';
      if (earlyPredictedD30Roi !== null) {
        reasons.push(
          `截至 ${addDays(targetDate, -1)} 暂无 D${maturityDay} 稳健样本，但已有 D3+ 早期样本预测 D30 ROI 为 ${(earlyPredictedD30Roi * 100).toFixed(1)}%。`,
        );
        nextSteps.push('先按早期指标保守决策，不加预算；等待 D7 完整成熟后再确认是否放量。');
      } else {
        reasons.push(`截至 ${addDays(targetDate, -1)} 还没有足够成熟样本，不能给出可靠的明日加投判断。`);
        nextSteps.push('明天保持小预算观察，等 D3/D7 数据成熟后再判断是否放量。');
      }
    }
  } else if (target.game_new_users <= 0) {
    action = 'fix_tracking';
    issueType = 'data_quality';
    reasons.push(`${targetDate} 的游戏新增为 0，无法计算 CPI 和回本线。`);
    nextSteps.push('先确认当天 SDK 打点、事件拉取和 user_daily 回算是否覆盖该日期。');
  } else if (target.data_status === 'small_sample' || target.data_status === 'conversion_abnormal') {
    action = 'observe';
    issueType = 'data_quality';
    reasons.push(`${targetDate} 被标记为${target.data_status_label}，不适合作为加投或降预算依据。`);
    nextSteps.push('先扩大到稳定小预算样本，或确认点击、归因和新增口径是否一致。');
    nextSteps.push('等目标日新增样本足够且点击转新增回到正常区间后，再判断 ROI。');
  } else if (target.d30_projected_ltv_cny === null) {
    action = 'observe';
    issueType = 'immature';
    reasons.push(`${targetDate} 还没有达到 D${maturityDay} LTV 成熟度，不建议据此加投。`);
    if (predictedD30Roi !== null) {
      reasons.push(`可用历史成熟样本预测 D30 ROI 为 ${(predictedD30Roi * 100).toFixed(1)}%。`);
    }
    nextSteps.push(`等待该批次至少到 D${maturityDay} 后再判断是否放量。`);
    nextSteps.push('在等待期间保持小预算稳定测试，不要大幅加预算。');
  } else if (target.d30_projected_roi !== null && target.d30_projected_roi >= 1.3 && target.game_new_users >= 500) {
    action = 'scale_cautiously';
    confidence = target.d30_projected_roi >= 1.5 && validRows.length >= 3 ? 'high' : 'medium';
    issueType = 'healthy';
    reasons.push(`${targetDate} D30 预测 ROI 为 ${(target.d30_projected_roi * 100).toFixed(1)}%，高于 130% 放量线。`);
    reasons.push(`CPI ${target.cpi_cny?.toFixed(4)} 元，低于可承受 CPI ${target.d30_projected_ltv_cny.toFixed(4)} 元。`);
    nextSteps.push('可以小幅放量，建议单日预算增加不超过 20%-30%。');
    nextSteps.push('继续跟踪 D7 ROI，如果 D7 后仍高于 130%，再扩大预算。');
  } else if (target.d30_projected_roi !== null && target.d30_projected_roi >= 1) {
    action = 'observe';
    confidence = 'medium';
    issueType = 'mixed';
    reasons.push(`${targetDate} D30 预测 ROI 为 ${(target.d30_projected_roi * 100).toFixed(1)}%，接近回本但安全边际不够。`);
    nextSteps.push('暂不加大投放，保持预算观察 D7 数据。');
    nextSteps.push('优先优化广告触发、留存和首日变现，提高 LTV 安全边际。');
  } else {
    // D30 预测不能回本时需要进一步区分原因：
    // - 首日 ROI 过低（每花 1 块当天回不到 5 分）说明游戏侧变现/留存/广告点位有问题；
    // - 首日 ROI 不算差但 CPI 远高于可承受 LTV，更可能是买量/素材/定向问题。
    // 旧实现按 `cpi > ltv ? reduce_budget : optimize_game` 判断，但 ROI<1 时 cpi 一定 > ltv，
    // 导致 optimize_game 永远不会触发；这里改用 D0 ROI 当变现强度的代理指标。
    const cpi = target.cpi_cny || 0;
    const ltv = target.d30_projected_ltv_cny || 0;
    const d0Roi = target.d0_roi ?? 0;
    const monetizationWeak = d0Roi < 0.05;
    action = monetizationWeak ? 'optimize_game' : 'reduce_budget';
    confidence = target.game_new_users >= 500 ? 'medium' : 'low';
    issueType = monetizationWeak ? 'game_monetization' : 'traffic';
    reasons.push(`${targetDate} D30 预测 ROI 低于 100%，当前批次预测不能回本。`);
    reasons.push(`CPI ${cpi.toFixed(4)} 元，可承受 CPI 约 ${ltv.toFixed(4)} 元；D0 ROI ${(d0Roi * 100).toFixed(1)}%。`);
    nextSteps.push(
      monetizationWeak
        ? '首日变现过弱，优先排查广告点位、激励触发频次、留存与新手引导，再考虑投放规模。'
        : '先降预算或暂停放量，优化素材/定向/出价以降低 CPI；CPI 回落后再小幅试投。',
    );
  }

  if (validRows.length === 0) {
    reasons.push(
      earlyRows.length > 0
        ? `目标日前没有可用 D${maturityDay} 稳健基线样本，已用 ${earlyRows.length} 天 D3+ 早期样本辅助判断。`
        : '目标日前没有可用成熟基线样本，结论置信度较低。',
    );
    confidence = 'low';
  } else {
    reasons.push(`基线纳入 ${validRows.length} 天，排除 ${samples.length - validRows.length} 天异常/未成熟样本。`);
  }

  const budgetRows = validRows.length > 0 ? validRows : earlyRows;
  const budgetPredictedD30Roi = predictedD30Roi ?? earlyPredictedD30Roi;
  const budgetWeightedD30Ltv = weightedD30Ltv ?? earlyWeightedD30Ltv;
  const budgetRecommendation = buildBudgetRecommendation({
    action,
    confidence,
    rowsAsc,
    validRows: budgetRows,
    predictedD30Roi: budgetPredictedD30Roi,
    weightedD30Ltv: budgetWeightedD30Ltv,
  });
  nextSteps.unshift(budgetRecommendation.note);
  if (budgetRecommendation.hard_stop_cpi_cny !== null) {
    nextSteps.push(
      `止损线：如果明天 CPI 高于 ${budgetRecommendation.hard_stop_cpi_cny.toFixed(4)} 元，说明买量成本已经超过可承受 LTV，应立即停止加预算。`,
    );
  }

  const issueLabels: Record<BusinessRoiDecisionResult['diagnostics']['issue_type'], string> = {
    traffic: '买量成本问题',
    game_monetization: '游戏/变现问题',
    data_quality: '数据口径问题',
    immature: '数据未成熟',
    healthy: '可谨慎放量',
    mixed: '边际不够稳',
  };
  const baseline = {
    valid_sample_days: validRows.length,
    excluded_sample_days: samples.length - validRows.length,
    total_spend_cny: round2(totalSpend),
    total_new_users: totalNewUsers,
    avg_cpi_cny: avgCpi ?? earlyAvgCpi,
    weighted_d30_ltv_cny: weightedD30Ltv ?? earlyWeightedD30Ltv,
    predicted_d30_roi: predictedD30Roi ?? earlyPredictedD30Roi,
    predicted_margin_per_user_cny:
      predictedMarginPerUser ??
      (earlyWeightedD30Ltv !== null && earlyAvgCpi !== null ? round4(earlyWeightedD30Ltv - earlyAvgCpi) : null),
  };
  const commercialDecision = mapCommercialDecision({
    action,
    issueType,
    confidence,
    reasons,
    nextSteps,
    budgetRecommendation,
    commercialSummary,
    baseline,
  });

  return {
    game_key: gameKey,
    target_date: targetDate,
    baseline_from_date: baselineFromDate,
    baseline_to_date: addDays(targetDate, -1),
    maturity_day: maturityDay,
    target,
    action,
    action_label: actionLabel(action),
    confidence,
    conclusion: `${actionLabel(action)}：${reasons[0] || '暂无足够数据判断。'}`,
    reasons,
    next_steps: nextSteps,
    diagnostics: {
      issue_type: issueType,
      issue_label: issueLabels[issueType],
    },
    commercial_decision: commercialDecision,
    budget_recommendation: budgetRecommendation,
    commercial_summary: commercialSummary,
    baseline,
    samples,
  };
}

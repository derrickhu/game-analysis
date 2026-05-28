import {
  listBusinessDailyInputs,
  listCohortLtvRows,
  listTencentAdsCreativeReportRawRows,
  listTencentAdsTargetingTagReportRawRows,
  type CohortLtvDailyRow,
  type TencentAdsCreativeReportRawRow,
  type TencentAdsTargetingTagReportRawRow,
} from '../ltv-db';

export interface AcquisitionIntelligenceMetricRow {
  key: string;
  label: string;
  group: string;
  spend_cny: number;
  impression: number;
  click: number;
  activation: number;
  ctr: number | null;
  cpc_cny: number | null;
  cpm_cny: number | null;
  cpa_cny: number | null;
  linked_d30_ltv_cny: number | null;
  linked_d30_roas: number | null;
  sample_days: number;
  diagnosis: string;
}

export interface AcquisitionOpportunity {
  type: 'scale' | 'optimize' | 'stop_loss' | 'creative_fatigue' | 'data_gap';
  title: string;
  detail: string;
  priority: 'high' | 'medium' | 'low';
}

export interface AcquisitionIntelligenceResult {
  game_key: string;
  from_date: string;
  to_date: string;
  summary: {
    total_spend_cny: number;
    total_impression: number;
    total_click: number;
    total_activation: number;
    avg_ctr: number | null;
    avg_cpc_cny: number | null;
    avg_cpm_cny: number | null;
    avg_cpa_cny: number | null;
    projected_d30_ltv_cny: number | null;
    projected_d30_roas: number | null;
    targeting_segments: number;
    creative_entities: number;
  };
  targeting_rankings: AcquisitionIntelligenceMetricRow[];
  creative_rankings: AcquisitionIntelligenceMetricRow[];
  opportunities: AcquisitionOpportunity[];
  data_notes: string[];
}

interface AggregatedMetric {
  key: string;
  label: string;
  group: string;
  spend: number;
  impression: number;
  click: number;
  activation: number;
  dates: Set<string>;
  weightedLtvNumerator: number;
  weightedLtvDenominator: number;
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

function buildLtvProjectionMap(rows: CohortLtvDailyRow[]): Map<string, number | null> {
  const byDate = new Map<string, CohortLtvDailyRow[]>();
  for (const row of rows) {
    const list = byDate.get(row.cohort_date) || [];
    list.push(row);
    byDate.set(row.cohort_date, list);
  }

  const out = new Map<string, number | null>();
  for (const [date, list] of byDate.entries()) {
    const byAge = new Map<number, number>();
    for (const row of list) {
      if (Number(row.is_complete_day) === 1) byAge.set(Number(row.age_day), Number(row.ltv_cny));
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

function diagnosisForMetric(row: Omit<AcquisitionIntelligenceMetricRow, 'diagnosis'>): string {
  if (row.spend_cny <= 0) return '暂无消耗，不能判断';
  if (row.impression < 1000 && row.click < 50) return '样本偏小，仅观察趋势';
  if (row.linked_d30_roas !== null && row.linked_d30_roas >= 1.2) return '同日 cohort 预测回收较好，可作为放量候选';
  if (row.cpa_cny !== null && row.linked_d30_ltv_cny !== null && row.cpa_cny > row.linked_d30_ltv_cny) {
    return '转化成本高于预测 LTV，优先降成本或收窄投放';
  }
  if (row.ctr !== null && row.ctr < 0.005) return 'CTR 偏低，素材/定向吸引力不足';
  if (row.cpc_cny !== null && row.cpc_cny > 2) return 'CPC 偏高，需优化素材点击率或出价';
  return '表现中性，建议结合留存和素材疲劳继续观察';
}

function toMetricRows(items: AggregatedMetric[]): AcquisitionIntelligenceMetricRow[] {
  return items
    .map((item) => {
      const linkedLtv = ratio(item.weightedLtvNumerator, item.weightedLtvDenominator);
      const cpa = ratio(item.spend, item.activation);
      const row: Omit<AcquisitionIntelligenceMetricRow, 'diagnosis'> = {
        key: item.key,
        label: item.label,
        group: item.group,
        spend_cny: round2(item.spend),
        impression: item.impression,
        click: item.click,
        activation: item.activation,
        ctr: ratio(item.click, item.impression),
        cpc_cny: ratio(item.spend, item.click),
        cpm_cny: item.impression > 0 ? round4((item.spend / item.impression) * 1000) : null,
        cpa_cny: cpa,
        linked_d30_ltv_cny: linkedLtv,
        linked_d30_roas: linkedLtv !== null && cpa !== null && cpa > 0 ? round4(linkedLtv / cpa) : null,
        sample_days: item.dates.size,
      };
      return { ...row, diagnosis: diagnosisForMetric(row) };
    })
    .sort((a, b) => b.spend_cny - a.spend_cny);
}

function addMetric(input: {
  map: Map<string, AggregatedMetric>;
  key: string;
  label: string;
  group: string;
  dateKey: string;
  spend: number;
  impression: number | null;
  click: number | null;
  activation: number | null;
  ltvByDate: Map<string, number | null>;
}): void {
  const current =
    input.map.get(input.key) ||
    {
      key: input.key,
      label: input.label,
      group: input.group,
      spend: 0,
      impression: 0,
      click: 0,
      activation: 0,
      dates: new Set<string>(),
      weightedLtvNumerator: 0,
      weightedLtvDenominator: 0,
    };
  current.spend += input.spend;
  current.impression += Math.max(0, Math.trunc(Number(input.impression || 0)));
  current.click += Math.max(0, Math.trunc(Number(input.click || 0)));
  current.activation += Math.max(0, Math.trunc(Number(input.activation || 0)));
  current.dates.add(input.dateKey);
  const ltv = input.ltvByDate.get(input.dateKey);
  if (ltv !== null && ltv !== undefined && input.spend > 0) {
    current.weightedLtvNumerator += ltv * input.spend;
    current.weightedLtvDenominator += input.spend;
  }
  input.map.set(input.key, current);
}

const REGION_LABELS: Record<string, string> = {
  '110000': '北京',
  '120000': '天津',
  '130000': '河北',
  '140000': '山西',
  '150000': '内蒙古',
  '210000': '辽宁',
  '220000': '吉林',
  '230000': '黑龙江',
  '310000': '上海',
  '320000': '江苏',
  '330000': '浙江',
  '340000': '安徽',
  '350000': '福建',
  '360000': '江西',
  '370000': '山东',
  '410000': '河南',
  '420000': '湖北',
  '430000': '湖南',
  '440000': '广东',
  '450000': '广西',
  '460000': '海南',
  '500000': '重庆',
  '510000': '四川',
  '520000': '贵州',
  '530000': '云南',
  '540000': '西藏',
  '610000': '陕西',
  '620000': '甘肃',
  '630000': '青海',
  '640000': '宁夏',
  '650000': '新疆',
  '710000': '台湾',
  '810000': '香港',
  '820000': '澳门',
};

function targetingLabel(type: string, value: string): string {
  if (type === 'GENDER') {
    if (value === '1') return '男性';
    if (value === '2') return '女性';
    if (value === '0' || value === 'UNKNOWN') return '未知/未识别';
  }
  if (type === 'AGE') {
    const age = Number(value);
    if (age === 13) return '13 岁及以下';
    if (age === 18) return '18 岁及以下';
    if (age === 24) return '19-24 岁';
    if (age === 29) return '25-29 岁';
    if (age === 39) return '30-39 岁';
    if (age === 49) return '40-49 岁';
    if (age === 50) return '50 岁及以上';
    if (age === 65) return '65 岁及以上';
    if (Number.isFinite(age)) return `${age} 岁段`;
  }
  if (type === 'REGION') return REGION_LABELS[value] || `地域 ${value}`;
  return value;
}

function buildTargetingRankings(
  rows: TencentAdsTargetingTagReportRawRow[],
  ltvByDate: Map<string, number | null>,
): AcquisitionIntelligenceMetricRow[] {
  const map = new Map<string, AggregatedMetric>();
  for (const row of rows) {
    const key = `${row.dimension_type}:${row.dimension_value}`;
    addMetric({
      map,
      key,
      label: targetingLabel(row.dimension_type, row.dimension_value),
      group: row.dimension_type,
      dateKey: row.date_key,
      spend: Number(row.cost_cny || 0),
      impression: row.impression,
      click: row.click,
      activation: row.activation,
      ltvByDate,
    });
  }
  return toMetricRows([...map.values()]);
}

function buildCreativeRankings(
  rows: TencentAdsCreativeReportRawRow[],
  ltvByDate: Map<string, number | null>,
): AcquisitionIntelligenceMetricRow[] {
  const map = new Map<string, AggregatedMetric>();
  for (const row of rows) {
    const key = `${row.report_level}:${row.entity_type}:${row.entity_id}`;
    addMetric({
      map,
      key,
      label: row.entity_name || row.entity_id,
      group: row.entity_type,
      dateKey: row.date_key,
      spend: Number(row.cost_cny || 0),
      impression: row.impression,
      click: row.click,
      activation: row.activation,
      ltvByDate,
    });
  }
  return toMetricRows([...map.values()]);
}

function buildCreativeFatigueOpportunities(rows: TencentAdsCreativeReportRawRow[]): AcquisitionOpportunity[] {
  const byEntity = new Map<string, TencentAdsCreativeReportRawRow[]>();
  for (const row of rows) {
    const key = `${row.report_level}:${row.entity_type}:${row.entity_id}`;
    const list = byEntity.get(key) || [];
    list.push(row);
    byEntity.set(key, list);
  }
  const out: AcquisitionOpportunity[] = [];
  for (const list of byEntity.values()) {
    const sorted = [...list].sort((a, b) => a.date_key.localeCompare(b.date_key));
    if (sorted.length < 4) continue;
    const mid = Math.floor(sorted.length / 2);
    const first = sorted.slice(0, mid);
    const second = sorted.slice(mid);
    const firstCtr = ratio(
      first.reduce((sum, row) => sum + Number(row.click || 0), 0),
      first.reduce((sum, row) => sum + Number(row.impression || 0), 0),
    );
    const secondCtr = ratio(
      second.reduce((sum, row) => sum + Number(row.click || 0), 0),
      second.reduce((sum, row) => sum + Number(row.impression || 0), 0),
    );
    const spend = sorted.reduce((sum, row) => sum + Number(row.cost_cny || 0), 0);
    if (firstCtr !== null && secondCtr !== null && spend > 20 && secondCtr < firstCtr * 0.75) {
      const latest = sorted[sorted.length - 1];
      out.push({
        type: 'creative_fatigue',
        priority: 'medium',
        title: `素材 ${latest.entity_id} 疑似疲劳`,
        detail: `前半段 CTR ${(firstCtr * 100).toFixed(2)}%，后半段降至 ${(secondCtr * 100).toFixed(2)}%，建议换首帧/卖点或降预算观察。`,
      });
    }
  }
  return out.slice(0, 3);
}

function buildOpportunities(input: {
  targeting: AcquisitionIntelligenceMetricRow[];
  creative: AcquisitionIntelligenceMetricRow[];
  creativeRawRows: TencentAdsCreativeReportRawRow[];
}): AcquisitionOpportunity[] {
  const out: AcquisitionOpportunity[] = [];
  const scalable = [...input.targeting, ...input.creative].find((row) => row.linked_d30_roas !== null && row.linked_d30_roas >= 1.2 && row.spend_cny >= 20);
  if (scalable) {
    out.push({
      type: 'scale',
      priority: 'high',
      title: `${scalable.group}「${scalable.label}」可作为放量候选`,
      detail: `消耗 ${scalable.spend_cny} 元，CTR ${scalable.ctr !== null ? `${(scalable.ctr * 100).toFixed(2)}%` : '-'}，同日 cohort 预测 ROAS ${scalable.linked_d30_roas !== null ? `${(scalable.linked_d30_roas * 100).toFixed(1)}%` : '-'}。`,
    });
  }

  const costly = [...input.targeting, ...input.creative].find(
    (row) => row.cpa_cny !== null && row.linked_d30_ltv_cny !== null && row.cpa_cny > row.linked_d30_ltv_cny && row.spend_cny >= 20,
  );
  if (costly) {
    out.push({
      type: 'stop_loss',
      priority: 'high',
      title: `${costly.group}「${costly.label}」成本高于可承受 LTV`,
      detail: `CPA ${costly.cpa_cny?.toFixed(4)} 元，高于同日预测 LTV ${costly.linked_d30_ltv_cny?.toFixed(4)} 元，建议降价、停投或换素材。`,
    });
  }

  out.push(...buildCreativeFatigueOpportunities(input.creativeRawRows));

  if (input.targeting.length === 0 && input.creative.length === 0) {
    out.push({
      type: 'data_gap',
      priority: 'high',
      title: '尚未沉淀腾讯广告洞察数据',
      detail: '请确认 TENCENT_ADS_INSIGHTS_ENABLED=true，并执行腾讯广告洞察拉数任务；当前只能看日级总 ROI。',
    });
  }

  return out.slice(0, 6);
}

export async function getAcquisitionIntelligenceOverview(
  gameKey: string,
  fromDate: string,
  toDate: string,
): Promise<AcquisitionIntelligenceResult> {
  const [businessRows, ltvRows, targetingRawRows, creativeRawRows] = await Promise.all([
    listBusinessDailyInputs(gameKey, fromDate, toDate),
    listCohortLtvRows(gameKey, fromDate, toDate),
    listTencentAdsTargetingTagReportRawRows(gameKey, fromDate, toDate),
    listTencentAdsCreativeReportRawRows(gameKey, fromDate, toDate),
  ]);
  const ltvByDate = buildLtvProjectionMap(ltvRows);
  const targetingRankings = buildTargetingRankings(targetingRawRows, ltvByDate).slice(0, 50);
  const creativeRankings = buildCreativeRankings(creativeRawRows, ltvByDate).slice(0, 50);
  const totalSpend = businessRows.reduce((sum, row) => sum + Number(row.spend_cny || 0), 0);
  const totalImpression = businessRows.reduce((sum, row) => sum + Number(row.acquisition_impressions || 0), 0);
  const totalClick = businessRows.reduce((sum, row) => sum + Number(row.wechat_clicks || 0), 0);
  const totalActivation = businessRows.reduce((sum, row) => sum + Number(row.acquisition_activations || 0), 0);
  const projectedLtv = ratio(
    businessRows.reduce((sum, row) => {
      const ltv = ltvByDate.get(row.date_key);
      return ltv !== null && ltv !== undefined ? sum + ltv * Number(row.spend_cny || 0) : sum;
    }, 0),
    businessRows.reduce((sum, row) => (ltvByDate.get(row.date_key) !== null && ltvByDate.get(row.date_key) !== undefined ? sum + Number(row.spend_cny || 0) : sum), 0),
  );
  const avgCpa = ratio(totalSpend, totalActivation);
  const dataNotes = [
    '性别、年龄、地域是腾讯广告定向标签报表的聚合分层数据，不是逐玩家明细画像。',
    'linked_d30_roas 使用同日全量游戏 cohort 的预测 LTV 近似评估分层回收，适合排序与发现机会，不等同于平台侧逐人群真实 LTV。',
  ];

  return {
    game_key: gameKey,
    from_date: fromDate,
    to_date: toDate,
    summary: {
      total_spend_cny: round2(totalSpend),
      total_impression: totalImpression,
      total_click: totalClick,
      total_activation: totalActivation,
      avg_ctr: ratio(totalClick, totalImpression),
      avg_cpc_cny: ratio(totalSpend, totalClick),
      avg_cpm_cny: totalImpression > 0 ? round4((totalSpend / totalImpression) * 1000) : null,
      avg_cpa_cny: avgCpa,
      projected_d30_ltv_cny: projectedLtv,
      projected_d30_roas: projectedLtv !== null && avgCpa !== null && avgCpa > 0 ? round4(projectedLtv / avgCpa) : null,
      targeting_segments: targetingRankings.length,
      creative_entities: creativeRankings.length,
    },
    targeting_rankings: targetingRankings,
    creative_rankings: creativeRankings,
    opportunities: buildOpportunities({
      targeting: targetingRankings,
      creative: creativeRankings,
      creativeRawRows,
    }),
    data_notes: dataNotes,
  };
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Col,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';

import { getGameDescriptor } from '../../shared/games';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';

const { Text } = Typography;

interface RoiRow {
  id: number;
  game_key: string;
  date_key: string;
  spend_cny: number;
  wechat_clicks: number;
  wechat_ad_revenue_cny: number;
  wechat_ad_impressions: number;
  acquisition_impressions: number;
  acquisition_activations: number;
  acquisition_source: string;
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
}

interface RoiResponse {
  ok: boolean;
  query?: { game_key: string; from_date: string; to_date: string };
  rows?: RoiRow[];
  summary?: {
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
  error?: string;
  code?: string;
}

interface RoiDecisionResponse {
  ok: boolean;
  action_label?: string;
  confidence?: 'high' | 'medium' | 'low';
  conclusion?: string;
  reasons?: string[];
  next_steps?: string[];
  maturity_day?: 3 | 7;
  target_date?: string;
  baseline_from_date?: string;
  baseline_to_date?: string;
  diagnostics?: { issue_label: string };
  commercial_decision?: {
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
  budget_recommendation?: {
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
  commercial_summary?: {
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
  baseline?: {
    valid_sample_days: number;
    excluded_sample_days: number;
    total_spend_cny: number;
    total_new_users: number;
    avg_cpi_cny: number | null;
    weighted_d30_ltv_cny: number | null;
    predicted_d30_roi: number | null;
    predicted_margin_per_user_cny: number | null;
  };
  samples?: Array<{
    date_key: string;
    included: boolean;
    reason: string;
    game_new_users: number;
    cpi_cny: number | null;
    d30_projected_ltv_cny: number | null;
    d30_projected_roi: number | null;
    data_status_label: string;
  }>;
  error?: string;
  code?: string;
}

interface RoiAiAnalysisResponse {
  ok: boolean;
  model?: string;
  generated_at?: number;
  analysis?: string;
  input_summary?: {
    from_date: string;
    to_date: string;
    decision_date: string;
    roi_rows: number;
    ltv_cohorts: number;
  };
  error?: string;
  code?: string;
}

interface MonetizationResponse {
  ok: boolean;
  ad_penetration_rate?: number;
  ad_show_cnt?: number;
  ad_show_per_uu?: number;
  fill_rate?: number;
  active_user_days?: number;
  error?: string;
  code?: string;
}

interface AcquisitionMetricRow {
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

interface AcquisitionOpportunity {
  type: 'scale' | 'optimize' | 'stop_loss' | 'creative_fatigue' | 'data_gap';
  title: string;
  detail: string;
  priority: 'high' | 'medium' | 'low';
}

interface AcquisitionIntelligenceResponse {
  ok: boolean;
  summary?: {
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
  targeting_rankings?: AcquisitionMetricRow[];
  creative_rankings?: AcquisitionMetricRow[];
  opportunities?: AcquisitionOpportunity[];
  data_notes?: string[];
  error?: string;
  code?: string;
}

function MetricTitle({ label, help }: { label: string; help: string }) {
  return (
    <Space size={4}>
      <span>{label}</span>
      <Tooltip title={help}>
        <Text type="secondary" style={{ cursor: 'help' }}>
          ?
        </Text>
      </Tooltip>
    </Space>
  );
}

function money(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '-';
  return value.toFixed(digits);
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function percentValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${value.toFixed(1)}%`;
}

function renderMissing(label: string) {
  return <Text type="secondary">{label}</Text>;
}

function missingReason(row: RoiRow): string {
  if (row.data_status_label) return row.data_status_label;
  if (row.game_new_users <= 0) return '无游戏打点';
  if (row.d30_projected_ltv_cny === null) return '数据未成熟';
  return '暂无数据';
}

function confidenceLabel(value?: RoiDecisionResponse['confidence']): string {
  if (value === 'high') return '高';
  if (value === 'medium') return '中';
  return '低';
}

function decisionAlertType(actionLabel?: string): 'success' | 'info' | 'warning' | 'error' {
  if (actionLabel === '可以加投' || actionLabel === '小幅放量') return 'success';
  if (actionLabel === '降预算' || actionLabel === '暂停投放' || actionLabel === '先修数据口径') return 'warning';
  if (actionLabel === '先优化游戏/变现') return 'error';
  return 'info';
}

function verdictAlertType(
  level?: NonNullable<RoiDecisionResponse['commercial_summary']>['verdict_level'],
): 'success' | 'info' | 'warning' | 'error' {
  if (level === 'healthy') return 'success';
  if (level === 'loss') return 'error';
  if (level === 'risky') return 'warning';
  return 'info';
}

function decisionType(decision?: RoiDecisionResponse['commercial_decision']): 'success' | 'info' | 'warning' | 'error' {
  if (!decision) return 'info';
  if (decision.decision === 'scale') return 'success';
  if (decision.decision === 'reduce' || decision.decision === 'hold' || decision.decision === 'wait_data') return 'warning';
  if (decision.decision === 'pause' || decision.decision === 'optimize_game') return 'error';
  return 'info';
}

type CommercialPrimaryProblem = NonNullable<RoiDecisionResponse['commercial_decision']>['primary_problem'];

function problemLabel(problem?: CommercialPrimaryProblem): string {
  const labels: Record<CommercialPrimaryProblem, string> = {
    buying_cost: '买量成本',
    monetization: '广告变现',
    retention: '留存质量',
    data_maturity: '数据成熟度',
    tracking: '数据口径',
  };
  return problem ? labels[problem] : '-';
}

function d30RoasBasisLabel(value?: 'mature' | 'early' | 'insufficient'): string {
  if (value === 'mature') return '成熟样本';
  if (value === 'early') return 'D3+ 早期样本';
  return '未成熟';
}

function opportunityPriorityLabel(value?: AcquisitionOpportunity['priority']): string {
  if (value === 'high') return '高优先级';
  if (value === 'medium') return '中优先级';
  return '低优先级';
}

function MetricCard({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <Card size="small">
      <Space orientation="vertical" size={2}>
        <Text type="secondary">{title}</Text>
        <Text strong style={{ fontSize: 20 }}>
          {value}
        </Text>
        {hint ? <Text type="secondary">{hint}</Text> : null}
      </Space>
    </Card>
  );
}

function defaultDisplayRange(): [Dayjs, Dayjs] {
  const yesterday = dayjs().subtract(1, 'day');
  return [yesterday.subtract(29, 'day'), yesterday];
}

async function fetchRoiData(gameKey: string, range: [Dayjs, Dayjs]): Promise<RoiResponse> {
  const [from, to] = range;
  const queryStr = new URLSearchParams({
    game: gameKey,
    from_date: from.format('YYYY-MM-DD'),
    to_date: to.format('YYYY-MM-DD'),
  }).toString();
  const res = await fetch(`/api/realtime/business-inputs?${queryStr}`);
  return (await res.json()) as RoiResponse;
}

async function fetchRoiDecision(
  gameKey: string,
  targetDate: Dayjs,
  baselineDays: number,
  maturityDay: 3 | 7,
): Promise<RoiDecisionResponse> {
  const queryStr = new URLSearchParams({
    game: gameKey,
    target_date: targetDate.format('YYYY-MM-DD'),
    baseline_days: String(baselineDays),
    maturity_day: String(maturityDay),
  }).toString();
  const res = await fetch(`/api/realtime/business-roi-decision?${queryStr}`);
  return (await res.json()) as RoiDecisionResponse;
}

async function fetchRoiAiAnalysis(gameKey: string, baselineDays: number, maturityDay: 3 | 7): Promise<RoiAiAnalysisResponse> {
  const res = await fetch('/api/realtime/business-roi-ai-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      game: gameKey,
      baseline_days: baselineDays,
      maturity_day: maturityDay,
    }),
  });
  return (await res.json()) as RoiAiAnalysisResponse;
}

async function fetchMonetizationData(gameKey: string, range: [Dayjs, Dayjs]): Promise<MonetizationResponse> {
  const [from, to] = range;
  const queryStr = new URLSearchParams({
    game: gameKey,
    from_date: from.format('YYYY-MM-DD'),
    to_date: to.format('YYYY-MM-DD'),
  }).toString();
  const res = await fetch(`/api/realtime/monetization?${queryStr}`);
  return (await res.json()) as MonetizationResponse;
}

async function fetchAcquisitionIntelligence(
  gameKey: string,
  range: [Dayjs, Dayjs],
): Promise<AcquisitionIntelligenceResponse> {
  const [from, to] = range;
  const queryStr = new URLSearchParams({
    game: gameKey,
    from_date: from.format('YYYY-MM-DD'),
    to_date: to.format('YYYY-MM-DD'),
  }).toString();
  const res = await fetch(`/api/realtime/acquisition-intelligence?${queryStr}`);
  return (await res.json()) as AcquisitionIntelligenceResponse;
}

/**
 * 通用 ROI 页面。
 * 腾讯广告消耗与微信流量主收入/曝光由后端自动补录，人工入口只作为异常修正和对账兜底。
 */
export function RoiPage({ displayRange }: { displayRange?: [Dayjs, Dayjs] } = {}) {
  const {
    gameKey,
    refreshToken,
    setLoading,
    setLastRefreshedAt,
  } = useAnalyticsFilter();
  const descriptor = getGameDescriptor(gameKey);
  const [data, setData] = useState<RoiResponse | null>(null);
  const [decision, setDecision] = useState<RoiDecisionResponse | null>(null);
  const [monetization, setMonetization] = useState<MonetizationResponse | null>(null);
  const [acquisition, setAcquisition] = useState<AcquisitionIntelligenceResponse | null>(null);
  const [baselineDays, setBaselineDays] = useState(7);
  const [maturityDay, setMaturityDay] = useState<3 | 7>(7);
  const [aiAnalysis, setAiAnalysis] = useState<RoiAiAnalysisResponse | null>(null);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const requestSeqRef = useRef(0);
  const aiRequestKeyRef = useRef<string | null>(null);

  const loadAll = useCallback(
    async (nextGameKey: string, range?: [Dayjs, Dayjs]) => {
      const desc = getGameDescriptor(nextGameKey);
      if (!desc?.hasAnalyticsSdk) {
        setData(null);
        setMonetization(null);
        setAcquisition(null);
        setLastRefreshedAt(Date.now());
        return null;
      }
      const seq = ++requestSeqRef.current;
      setLoading(true);
      try {
        const activeRange = range || displayRange || defaultDisplayRange();
        const [json, monetizationJson, acquisitionJson] = await Promise.all([
          fetchRoiData(nextGameKey, activeRange),
          fetchMonetizationData(nextGameKey, activeRange),
          fetchAcquisitionIntelligence(nextGameKey, activeRange),
        ]);
        if (seq !== requestSeqRef.current) return null;
        if (!json.ok) message.error(`获取 ROI 数据失败: ${json.error || json.code}`);
        if (!monetizationJson.ok) message.warning(`获取商业化流量数据失败: ${monetizationJson.error || monetizationJson.code}`);
        if (!acquisitionJson.ok) message.warning(`获取投放洞察失败: ${acquisitionJson.error || acquisitionJson.code}`);
        setData(json);
        setMonetization(monetizationJson);
        setAcquisition(acquisitionJson);
        setLastRefreshedAt(Date.now());
        return json;
      } catch (error) {
        if (seq !== requestSeqRef.current) return null;
        message.error(`加载 ROI 页面失败: ${String(error)}`);
        return null;
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [displayRange, setLastRefreshedAt, setLoading],
  );

  useEffect(() => {
    void loadAll(gameKey);
  }, [gameKey, displayRange, refreshToken, loadAll]);

  const loadDecision = useCallback(
    async (nextBaselineDays = baselineDays, nextMaturityDay = maturityDay) => {
      setDecisionLoading(true);
      try {
        const json = await fetchRoiDecision(gameKey, dayjs(), nextBaselineDays, nextMaturityDay);
        if (!json.ok) {
          message.error(`获取投放决策失败: ${json.error || json.code}`);
          return;
        }
        setDecision(json);
      } catch (error) {
        message.error(`获取投放决策异常: ${String(error)}`);
      } finally {
        setDecisionLoading(false);
      }
    },
    [baselineDays, gameKey, maturityDay],
  );

  useEffect(() => {
    void loadDecision(baselineDays, maturityDay);
  }, [baselineDays, gameKey, loadDecision, maturityDay]);

  const onAiAnalyze = async () => {
    setAiLoading(true);
    try {
      const json = await fetchRoiAiAnalysis(gameKey, baselineDays, maturityDay);
      if (!json.ok) {
        message.error(`AI 分析失败: ${json.error || json.code}`);
        setAiAnalysis(json);
        return;
      }
      setAiAnalysis(json);
      message.success('AI 分析完成');
    } catch (error) {
      message.error(`AI 分析异常: ${String(error)}`);
    } finally {
      setAiLoading(false);
    }
  };

  useEffect(() => {
    if (!decision?.target_date || aiAnalysis?.ok || aiLoading) return;
    const key = `${gameKey}-${decision.target_date}-${baselineDays}-${maturityDay}`;
    if (aiRequestKeyRef.current === key) return;
    aiRequestKeyRef.current = key;
    void onAiAnalyze();
  }, [aiAnalysis?.ok, aiLoading, baselineDays, decision?.target_date, gameKey, maturityDay]);

  const onDelete = async (dateKey: string) => {
    const res = await fetch(
      `/api/realtime/business-inputs?game=${encodeURIComponent(gameKey)}&date_key=${encodeURIComponent(dateKey)}`,
      { method: 'DELETE' },
    );
    const json = await res.json();
    if (!json.ok) {
      message.error(`删除失败: ${json.error || json.code}`);
      return;
    }
    message.success('已删除');
    await loadAll(gameKey);
  };

  const rangeLabel = data?.query ? `${data.query.from_date} ~ ${data.query.to_date}` : '-';
  const summary = data?.summary;
  const commercialDecision = decision?.commercial_decision;
  const coreMetrics = commercialDecision?.core_metrics;
  const monetizationFlow = decision?.commercial_summary?.monetization_flow;
  const adPenetration = monetizationFlow?.ad_penetration_rate ?? (monetization?.ad_penetration_rate !== undefined ? monetization.ad_penetration_rate / 100 : null);
  const adShowPerUser = monetizationFlow?.ad_show_per_ad_user ?? monetization?.ad_show_per_uu ?? null;
  const actualEcpm = monetizationFlow?.actual_ecpm_cny ?? summary?.actual_ecpm_cny ?? null;
  const projectedD30Roi = coreMetrics?.projected_d30_roas ?? decision?.commercial_summary?.early_d30_roi ?? decision?.baseline?.predicted_d30_roi ?? null;
  const projectedD30Ltv = coreMetrics?.projected_d30_ltv_cny ?? decision?.commercial_summary?.early_d30_ltv_cny ?? decision?.baseline?.weighted_d30_ltv_cny ?? null;
  const d30Basis = coreMetrics?.d30_roas_basis ?? (decision?.baseline?.predicted_d30_roi !== null && decision?.baseline?.predicted_d30_roi !== undefined ? 'mature' : projectedD30Roi !== null ? 'early' : 'insufficient');
  const headline = commercialDecision?.headline || decision?.conclusion || decision?.commercial_summary?.verdict_label || '正在生成商业化结论';
  const aiAvailable = aiAnalysis?.ok && aiAnalysis.analysis;
  const acquisitionSummary = acquisition?.summary;
  const acquisitionOpportunities = acquisition?.opportunities || [];
  const topTargeting = acquisition?.targeting_rankings || [];
  const genderTargeting = topTargeting.filter((row) => row.group === 'GENDER');
  const ageTargeting = topTargeting.filter((row) => row.group === 'AGE');
  const regionTargeting = topTargeting.filter((row) => row.group === 'REGION');
  const topCreative = acquisition?.creative_rankings || [];

  const targetingColumns: ColumnsType<AcquisitionMetricRow> = useMemo(
    () => [
      { title: '标签', dataIndex: 'label', width: 120 },
      { title: '消耗', render: (_, row) => money(row.spend_cny), width: 90 },
      { title: '曝光', dataIndex: 'impression', width: 90 },
      { title: '点击', dataIndex: 'click', width: 80 },
      { title: 'CTR', render: (_, row) => percent(row.ctr), width: 80 },
      { title: 'CPC', render: (_, row) => money(row.cpc_cny, 4), width: 80 },
      { title: 'D30 LTV', render: (_, row) => money(row.linked_d30_ltv_cny, 4), width: 90 },
    ],
    [],
  );

  const columns: ColumnsType<RoiRow> = useMemo(
    () => [
      { title: '日期', dataIndex: 'date_key', fixed: 'left', width: 110 },
      {
        title: <MetricTitle label="腾讯广告消耗 cost" help="腾讯广告 Marketing API 返回的 cost，接口单位为分，系统已换算为元。用于计算 CPI、ROI。" />,
        render: (_, r) => money(r.spend_cny, 2),
        width: 140,
      },
      {
        title: <MetricTitle label="流量主真实收入" help="微信流量主 publisher/stat 返回的 income，接口单位为分，系统已换算为元。ROI 和真实盈亏以这个字段为准。" />,
        render: (_, r) => money(r.wechat_ad_revenue_cny, 2),
        width: 130,
      },
      {
        title: <MetricTitle label="D0 真实盈亏" help="微信真实收入 - 投放花费。大于 0 代表当天收入已经覆盖投放成本。" />,
        render: (_, r) => money(r.d0_margin_cny, 2),
        width: 120,
      },
      {
        title: <MetricTitle label="D0 ROI" help="微信真实收入 / 投放花费。表示当天真实广告收入覆盖投放成本的比例。" />,
        render: (_, r) => percent(r.d0_roi),
        width: 100,
      },
      {
        title: <MetricTitle label="投放点击 click" help="腾讯广告 Marketing API 的 click。当前账户接口未返回该字段时会保留已有值；CPI 不依赖点击。" />,
        dataIndex: 'wechat_clicks',
        width: 110,
      },
      {
        title: <MetricTitle label="投放曝光 impression" help="腾讯广告 Marketing API 的 impression。当前账户接口未返回该字段时显示为 0/保留已有值，不参与真实 eCPM。" />,
        dataIndex: 'acquisition_impressions',
        width: 140,
      },
      {
        title: <MetricTitle label="投放激活" help="腾讯广告返回的转化/激活量，由自动拉数写入；不同账户回传口径可能不同，仅做投放侧参考。" />,
        dataIndex: 'acquisition_activations',
        width: 110,
      },
      {
        title: <MetricTitle label="CPC" help="投放花费 / 腾讯广告点击。当前腾讯接口未返回 click 时该指标不可用于决策。" />,
        render: (_, r) => money(r.cpc_cny, 4),
        width: 90,
      },
      {
        title: <MetricTitle label="CPI" help="投放花费 / 游戏新增用户。表示一个真实进入游戏新增用户的成本。" />,
        render: (_, r) => (r.cpi_cny === null ? renderMissing(missingReason(r)) : money(r.cpi_cny, 4)),
        width: 90,
      },
      {
        title: <MetricTitle label="游戏新增" help="系统自动计算：当天 first_seen 用户数。代表真实进入游戏并被打点记录的新用户。" />,
        dataIndex: 'game_new_users',
        width: 110,
      },
      {
        title: <MetricTitle label="点击转新增" help="游戏新增用户 / 腾讯广告点击。当前腾讯接口未返回 click 时不作为核心判断。" />,
        render: (_, r) => (r.click_to_new_user_rate === null ? renderMissing(missingReason(r)) : percent(r.click_to_new_user_rate)),
        width: 120,
      },
      {
        title: <MetricTitle label="流量主真实曝光" help="微信流量主 publisher/stat 返回的 exposure_count，用于计算真实 eCPM 和 LTV 真实收入口径。" />,
        dataIndex: 'wechat_ad_impressions',
        width: 130,
      },
      {
        title: <MetricTitle label="真实 eCPM" help="流量主真实收入 / 流量主真实曝光 × 1000。用于覆盖估算 eCPM，进入 LTV 回算。" />,
        render: (_, r) => (r.actual_ecpm_cny === null ? renderMissing('未填曝光') : money(r.actual_ecpm_cny, 2)),
        width: 130,
      },
      {
        title: <MetricTitle label="D30 预测 ROI" help="D30 预测 LTV / CPI。用于判断这批新增用户 30 天预测能否回本。" />,
        render: (_, r) => (r.d30_projected_roi === null ? renderMissing(missingReason(r)) : percent(r.d30_projected_roi)),
        width: 130,
      },
      {
        title: <MetricTitle label="预测毛利" help="D30 预测 LTV - CPI。大于 0 代表按预测 30 天有正毛利。" />,
        render: (_, r) => (r.d30_projected_margin_cny === null ? renderMissing(missingReason(r)) : money(r.d30_projected_margin_cny, 4)),
        width: 110,
      },
      {
        title: '状态',
        render: (_, r) => r.data_status_label || missingReason(r),
        width: 110,
      },
      { title: '备注', dataIndex: 'note', width: 160 },
      {
        title: '操作',
        render: (_, r) => (
          <Popconfirm title="确认删除这天的录入？" onConfirm={() => void onDelete(r.date_key)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        ),
        width: 90,
      },
    ],
    [gameKey],
  );

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Card>
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type={decisionType(commercialDecision)}
            showIcon
            message={headline}
            description={
              decision
                ? `统计窗口：${rangeLabel}；置信度：${confidenceLabel(commercialDecision?.confidence ?? decision.confidence)}；核心问题：${problemLabel(commercialDecision?.primary_problem)}；D30 判断样本：${coreMetrics?.sample_days ?? decision.commercial_summary?.early_sample_days ?? 0} 天（${d30RoasBasisLabel(d30Basis)}）；建议预算：${money(decision.budget_recommendation?.recommended_min_cny)}-${money(decision.budget_recommendation?.recommended_max_cny)} 元；止损 CPI：${money(decision.budget_recommendation?.hard_stop_cpi_cny, 4)} 元。`
                : `当前游戏：${descriptor?.displayName ?? gameKey}；系统会基于腾讯广告消耗、微信流量主收入/曝光、游戏新增和 LTV 自动判断。`
            }
          />
          <Row gutter={[16, 16]}>
            <Col xs={12} md={4}>
              <MetricCard title="窗口总消耗" value={`${money(summary?.total_spend_cny)} 元`} hint={`统计窗口：${rangeLabel}`} />
            </Col>
            <Col xs={12} md={4}>
              <MetricCard title="窗口总收入" value={`${money(summary?.total_wechat_revenue_cny)} 元`} hint="微信流量主真实收入" />
            </Col>
            <Col xs={12} md={4}>
              <MetricCard title="窗口新增用户" value={`${summary?.total_game_new_users ?? 0}`} hint="游戏 first_seen" />
            </Col>
            <Col xs={12} md={4}>
              <MetricCard title="窗口平均 CPI" value={`${money(summary?.avg_cpi_cny, 4)} 元`} hint="窗口消耗 / 窗口新增，不依赖 click" />
            </Col>
            <Col xs={12} md={4}>
              <MetricCard
                title="预测 D30 ROI"
                value={percent(projectedD30Roi)}
                hint={`${d30RoasBasisLabel(d30Basis)}；LTV ${money(projectedD30Ltv, 4)} 元`}
              />
            </Col>
            <Col xs={12} md={4}>
              <MetricCard title="窗口 D0 ROI" value={percent(summary?.d0_roi)} hint="窗口真实收入 / 窗口消耗" />
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={8}>
              <MetricCard title="广告渗透" value={percent(adPenetration)} hint="同流量分析 user_daily 口径" />
            </Col>
            <Col xs={24} md={8}>
              <MetricCard title="人均广告展示" value={`${money(adShowPerUser, 2)} 次`} hint="看广告用户人均展示" />
            </Col>
            <Col xs={24} md={8}>
              <MetricCard title="真实 eCPM" value={`${money(actualEcpm, 2)} 元`} hint={`微信流量主收入 / 曝光；填充率 ${percentValue(monetization?.fill_rate)}`} />
            </Col>
          </Row>
          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Card size="small" title="关键原因">
                <Space orientation="vertical">
                  {(commercialDecision?.key_reasons || ['暂无足够数据形成稳定结论']).slice(0, 3).map((reason) => (
                    <Text key={reason}>{reason}</Text>
                  ))}
                </Space>
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card size="small" title="下一步动作">
                <Space orientation="vertical">
                  {(commercialDecision?.actions || ['先保持小预算观察，等待更多成熟 LTV 样本。']).slice(0, 3).map((action) => (
                    <Text key={action}>{action}</Text>
                  ))}
                </Space>
              </Card>
            </Col>
          </Row>
          <Card size="small" title="AI 经营建议">
            {aiAvailable ? (
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit', maxHeight: 160, overflow: 'auto' }}>
                {aiAnalysis.analysis}
              </pre>
            ) : (
              <Space>
                <Text type="secondary">规则分析已可用，AI 建议暂未生成或暂不可用。</Text>
                <Button size="small" loading={aiLoading} onClick={() => void onAiAnalyze()}>
                  生成 AI 建议
                </Button>
              </Space>
            )}
          </Card>
        </Space>
      </Card>

      <Card title="腾讯广告投放洞察" extra={<Text type="secondary">人群画像为平台聚合数据，非逐玩家明细</Text>}>
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={4}>
              <MetricCard title="分层消耗" value={`${money(acquisitionSummary?.total_spend_cny)} 元`} hint="来自腾讯广告洞察原始表" />
            </Col>
            <Col xs={12} md={4}>
              <MetricCard title="分层曝光" value={`${acquisitionSummary?.total_impression ?? 0}`} hint="定向/创意聚合" />
            </Col>
            <Col xs={12} md={4}>
              <MetricCard title="分层 CTR" value={percent(acquisitionSummary?.avg_ctr)} hint="点击 / 曝光" />
            </Col>
            <Col xs={12} md={4}>
              <MetricCard title="分层 CPC" value={`${money(acquisitionSummary?.avg_cpc_cny, 4)} 元`} hint="消耗 / 点击" />
            </Col>
            <Col xs={12} md={4}>
              <MetricCard title="预测回收" value={percent(acquisitionSummary?.projected_d30_roas)} hint={`同日 LTV ${money(acquisitionSummary?.projected_d30_ltv_cny, 4)} 元`} />
            </Col>
            <Col xs={12} md={4}>
              <MetricCard title="分层数量" value={`${(acquisitionSummary?.targeting_segments ?? 0) + (acquisitionSummary?.creative_entities ?? 0)}`} hint="性别/年龄/地域 + 创意实体" />
            </Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24} md={12}>
              <Card size="small" title="机会清单">
                <Space orientation="vertical" style={{ width: '100%' }}>
                  {(acquisitionOpportunities.length > 0 ? acquisitionOpportunities : [{ type: 'data_gap', priority: 'low', title: '暂无投放洞察结论', detail: '等待腾讯广告洞察任务拉取定向标签或创意素材数据。' } as AcquisitionOpportunity]).map((item) => (
                    <Alert
                      key={`${item.type}-${item.title}`}
                      type={item.priority === 'high' ? 'warning' : 'info'}
                      showIcon
                      message={`${opportunityPriorityLabel(item.priority)}：${item.title}`}
                      description={item.detail}
                    />
                  ))}
                </Space>
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card size="small" title="口径说明">
                <Space orientation="vertical">
                  {(acquisition?.data_notes || ['当前还没有投放洞察数据；基础 ROI 不受影响。']).map((note) => (
                    <Text key={note} type="secondary">{note}</Text>
                  ))}
                </Space>
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Card size="small" title="性别定向分布" extra={<Text type="secondary">按消耗排序</Text>}>
                <Table<AcquisitionMetricRow>
                  rowKey="key"
                  size="small"
                  dataSource={genderTargeting.slice(0, 6)}
                  pagination={false}
                  scroll={{ x: 640 }}
                  columns={targetingColumns}
                />
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title="年龄定向分布" extra={<Text type="secondary">腾讯广告年龄段：≤18 / 19-24 / 25-29 / 30-39 / 40-49 / ≥50</Text>}>
                <Table<AcquisitionMetricRow>
                  rowKey="key"
                  size="small"
                  dataSource={ageTargeting.slice(0, 8)}
                  pagination={false}
                  scroll={{ x: 640 }}
                  columns={targetingColumns}
                />
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24}>
              <Card size="small" title="地域定向分布" extra={<Text type="secondary">省份 Top，适合看流量集中地和低价区域</Text>}>
                <Table<AcquisitionMetricRow>
                  rowKey="key"
                  size="small"
                  dataSource={regionTargeting.slice(0, 15)}
                  pagination={false}
                  scroll={{ x: 760 }}
                  columns={[
                    ...targetingColumns,
                    { title: '诊断', dataIndex: 'diagnosis', width: 220 },
                  ]}
                />
              </Card>
            </Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24}>
              <Card size="small" title="创意 / 素材排行">
                <Table<AcquisitionMetricRow>
                  rowKey="key"
                  size="small"
                  dataSource={topCreative.slice(0, 10)}
                  pagination={false}
                  scroll={{ x: 900 }}
                  columns={[
                    { title: '类型', dataIndex: 'group', width: 100 },
                    { title: 'ID/名称', dataIndex: 'label', width: 150 },
                    { title: '消耗', render: (_, row) => money(row.spend_cny), width: 90 },
                    { title: 'CTR', render: (_, row) => percent(row.ctr), width: 90 },
                    { title: 'CPC', render: (_, row) => money(row.cpc_cny, 4), width: 90 },
                    { title: '预测 ROAS', render: (_, row) => percent(row.linked_d30_roas), width: 110 },
                    { title: '诊断', dataIndex: 'diagnosis', width: 220 },
                  ]}
                />
              </Card>
            </Col>
          </Row>

        </Space>
      </Card>


      <Collapse
        defaultActiveKey={['roi-details']}
        items={[
          {
            key: 'roi-details',
            label: 'ROI 明细与对账数据',
            children: (
              <>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={4}>
          <Card>
            <Statistic title="总花费" value={summary?.total_spend_cny ?? 0} precision={2} />
          </Card>
        </Col>
        <Col xs={12} md={4}>
          <Card>
            <Statistic title="流量主真实收入" value={summary?.total_wechat_revenue_cny ?? 0} precision={2} />
          </Card>
        </Col>
        <Col xs={12} md={4}>
          <Card>
            <Statistic title="D0 真实盈亏" value={summary?.total_d0_margin_cny ?? 0} precision={2} />
          </Card>
        </Col>
        <Col xs={12} md={4}>
          <Card>
            <Statistic title="游戏新增" value={summary?.total_game_new_users ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={4}>
          <Card>
            <Statistic title="平均 CPI" value={summary?.avg_cpi_cny ?? 0} precision={4} />
          </Card>
        </Col>
        <Col xs={12} md={4}>
          <Card>
            <Statistic title="真实 eCPM" value={summary?.actual_ecpm_cny ?? 0} precision={2} />
          </Card>
        </Col>
        <Col xs={12} md={4}>
          <Card>
            <Statistic title="D0 ROI" value={(summary?.d0_roi ?? 0) * 100} suffix="%" precision={1} />
          </Card>
        </Col>
      </Row>

      <Card title="ROI 明细（真实收入/盈亏优先展示）">
        <Table
          rowKey={(row) => `${row.game_key}-${row.date_key}`}
          columns={columns}
          dataSource={data?.rows || []}
          size="small"
          scroll={{ x: 1700 }}
          pagination={{ pageSize: 10 }}
        />
      </Card>
              </>
            ),
          },
        ]}
      />
    </Space>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
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
import type { WindowValue } from '../timeWindow';

const { Text } = Typography;
const { RangePicker } = DatePicker;

interface RoiRow {
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

interface RoiRangeFormValues {
  date_range: [Dayjs, Dayjs];
}

interface RoiDraftRow {
  date_key: string;
  spend_cny: number;
  wechat_clicks: number;
  wechat_ad_revenue_cny: number;
  wechat_ad_impressions: number;
  note?: string;
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

function eachDateInRange(from: Dayjs, to: Dayjs): string[] {
  const dates: string[] = [];
  let cursor = from.startOf('day');
  const end = to.startOf('day');
  while (cursor.isBefore(end) || cursor.isSame(end)) {
    dates.push(cursor.format('YYYY-MM-DD'));
    cursor = cursor.add(1, 'day');
  }
  return dates;
}

function buildDraftRows(from: Dayjs, to: Dayjs, existingRows: RoiRow[] = []): RoiDraftRow[] {
  const existingByDate = new Map(existingRows.map((row) => [row.date_key, row]));
  return eachDateInRange(from, to).map((dateKey) => {
    const existing = existingByDate.get(dateKey);
    return {
      date_key: dateKey,
      spend_cny: existing?.spend_cny ?? 0,
      wechat_clicks: existing?.wechat_clicks ?? 0,
      wechat_ad_revenue_cny: existing?.wechat_ad_revenue_cny ?? 0,
      wechat_ad_impressions: existing?.wechat_ad_impressions ?? 0,
      note: existing?.note ?? '',
    };
  });
}

function defaultInputRange(): [Dayjs, Dayjs] {
  const yesterday = dayjs().subtract(1, 'day');
  return [yesterday.subtract(6, 'day'), yesterday];
}

function disableTodayAndFuture(current: Dayjs): boolean {
  return current.startOf('day').isSame(dayjs().startOf('day')) || current.isAfter(dayjs(), 'day');
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

/**
 * 通用 ROI 录入页面。
 * 人工录入投放与微信真实结算数据，新增用户/LTV/估算收入由系统自动关联。
 */
export function RoiPage() {
  const {
    gameKey,
    windowSel,
    refreshToken,
    setLoading,
    setLastRefreshedAt,
  } = useAnalyticsFilter();
  const descriptor = getGameDescriptor(gameKey);
  const [rangeForm] = Form.useForm<RoiRangeFormValues>();
  const [data, setData] = useState<RoiResponse | null>(null);
  const [decision, setDecision] = useState<RoiDecisionResponse | null>(null);
  const [baselineDays, setBaselineDays] = useState(7);
  const [maturityDay, setMaturityDay] = useState<3 | 7>(3);
  const [draftRows, setDraftRows] = useState<RoiDraftRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [decisionLoading, setDecisionLoading] = useState(false);
  const requestSeqRef = useRef(0);
  const draftInitializedGameRef = useRef<string | null>(null);

  const loadAll = useCallback(
    async (nextGameKey: string, _nextWindow: WindowValue, range?: [Dayjs, Dayjs]) => {
      const desc = getGameDescriptor(nextGameKey);
      if (!desc?.hasAnalyticsSdk) {
        setData(null);
        setLastRefreshedAt(Date.now());
        return null;
      }
      const seq = ++requestSeqRef.current;
      setLoading(true);
      try {
        const activeRange = range || rangeForm.getFieldValue('date_range') || defaultInputRange();
        const json = await fetchRoiData(nextGameKey, activeRange);
        if (seq !== requestSeqRef.current) return null;
        if (!json.ok) message.error(`获取 ROI 数据失败: ${json.error || json.code}`);
        setData(json);
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
    [rangeForm, setLastRefreshedAt, setLoading],
  );

  useEffect(() => {
    void loadAll(gameKey, windowSel);
  }, [gameKey, windowSel, refreshToken, loadAll]);

  const regenerateDraftRows = useCallback(
    async (range: [Dayjs, Dayjs]) => {
      const [from, to] = range;
      const days = to.startOf('day').diff(from.startOf('day'), 'day') + 1;
      if (days > 31) {
        message.warning('一次最多生成 31 天，避免误操作覆盖太多数据');
        return;
      }
      try {
        setLoading(true);
        const nextData = await fetchRoiData(gameKey, range);
        if (!nextData.ok) {
          message.error(`获取已录入数据失败: ${nextData.error || nextData.code}`);
          return;
        }
        setData(nextData);
        setDraftRows(buildDraftRows(from, to, nextData.rows || []));
        setLastRefreshedAt(Date.now());
      } catch (error) {
        message.error(`生成多行失败: ${String(error)}`);
      } finally {
        setLoading(false);
      }
    },
    [gameKey, setLastRefreshedAt, setLoading],
  );

  useEffect(() => {
    if (draftInitializedGameRef.current === gameKey) return;
    const defaultRange = defaultInputRange();
    rangeForm.setFieldsValue({ date_range: defaultRange });
    draftInitializedGameRef.current = gameKey;
    void regenerateDraftRows(defaultRange);
  }, [gameKey, rangeForm, regenerateDraftRows]);

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

  const updateDraftRow = (dateKey: string, patch: Partial<RoiDraftRow>) => {
    setDraftRows((rows) => rows.map((row) => (row.date_key === dateKey ? { ...row, ...patch } : row)));
  };

  const onGenerateRows = async (values: RoiRangeFormValues) => {
    await regenerateDraftRows(values.date_range);
  };

  const onUseLast7Days = async () => {
    const range = defaultInputRange();
    rangeForm.setFieldsValue({ date_range: range });
    await regenerateDraftRows(range);
  };

  const onBatchSubmit = async () => {
    const rowsToSave = draftRows.filter(
      (row) =>
        row.spend_cny > 0 ||
        row.wechat_clicks > 0 ||
        row.wechat_ad_revenue_cny > 0 ||
        row.wechat_ad_impressions > 0 ||
        Boolean(row.note?.trim()),
    );
    if (rowsToSave.length === 0) {
      message.warning('没有需要保存的数据行');
      return;
    }
    setSaving(true);
    try {
      for (const row of rowsToSave) {
        const res = await fetch('/api/realtime/business-inputs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: gameKey, ...row }),
        });
        const json = await res.json();
        if (!json.ok) {
          message.error(`${row.date_key} 保存失败: ${json.error || json.code}`);
          return;
        }
      }
      message.success(`已保存 ${rowsToSave.length} 天经营数据`);
      await loadAll(gameKey, windowSel, rangeForm.getFieldValue('date_range'));
    } catch (error) {
      message.error(`保存异常: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  };

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
    await loadAll(gameKey, windowSel);
  };

  const rangeLabel = data?.query ? `${data.query.from_date} ~ ${data.query.to_date}` : '-';
  const summary = data?.summary;

  const columns: ColumnsType<RoiRow> = useMemo(
    () => [
      { title: '日期', dataIndex: 'date_key', fixed: 'left', width: 110 },
      {
        title: <MetricTitle label="投放花费" help="你手工录入的真实投放消耗，单位元。用于计算 CPC、CPI、ROI。" />,
        render: (_, r) => money(r.spend_cny, 2),
        width: 110,
      },
      {
        title: <MetricTitle label="微信真实收入" help="你手工录入的微信流量主后台真实广告收入，单位元。ROI 和真实盈亏以这个字段为准。" />,
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
        title: <MetricTitle label="微信点击" help="你手工录入的微信广告点击次数。用于计算 CPC 和点击转新增率。" />,
        dataIndex: 'wechat_clicks',
        width: 110,
      },
      {
        title: <MetricTitle label="CPC" help="投放花费 / 微信点击次数。表示一次点击的成本。" />,
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
        title: <MetricTitle label="点击转新增" help="游戏新增用户 / 微信点击次数。用于判断点击后加载、进入游戏、首次打点的转化质量。" />,
        render: (_, r) => (r.click_to_new_user_rate === null ? renderMissing(missingReason(r)) : percent(r.click_to_new_user_rate)),
        width: 120,
      },
      {
        title: <MetricTitle label="微信真实曝光（可选）" help="只用于计算真实 eCPM，不参与 ROI。填全部广告位曝光会得到激励+插屏的混合 eCPM；拿不到就填 0。" />,
        dataIndex: 'wechat_ad_impressions',
        width: 150,
      },
      {
        title: <MetricTitle label="真实 eCPM（可选）" help="微信真实收入 / 微信真实曝光 × 1000。曝光填 0 时不展示，不影响 ROI 和盈亏判断。" />,
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
    [gameKey, windowSel],
  );

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={`ROI / 经营录入 · 当前游戏：${descriptor?.displayName ?? gameKey} · 统计范围：${rangeLabel}`}
        description="ROI 只依赖投放花费、微信真实收入和游戏新增；曝光只用于算真实 eCPM。微信后台如果只能给激励+插屏总曝光，就填总曝光得到混合 eCPM；如果暂时拿不到曝光，填 0 也不影响 ROI。"
      />

      <Card title="明日投放策略">
        <Row gutter={[16, 8]} align="bottom">
          <Col xs={12} md={4}>
            <Text type="secondary">基线天数</Text>
            <InputNumber
              min={3}
              max={30}
              value={baselineDays}
              style={{ width: '100%', marginTop: 8 }}
              onChange={(value) => setBaselineDays(Number(value) || 7)}
            />
          </Col>
          <Col xs={12} md={4}>
            <Text type="secondary">成熟口径</Text>
            <Select
              value={maturityDay}
              style={{ width: '100%', marginTop: 8 }}
              options={[
                { value: 3, label: 'D3 早期判断' },
                { value: 7, label: 'D7 稳健判断' },
              ]}
              onChange={(value) => setMaturityDay(value as 3 | 7)}
            />
          </Col>
          <Col xs={24} md={5}>
            <Button
              type="primary"
              loading={decisionLoading}
              onClick={() => void loadDecision(baselineDays, maturityDay)}
            >
              刷新明日策略
            </Button>
          </Col>
        </Row>

        <Space orientation="vertical" size="middle" style={{ width: '100%', marginTop: 16 }}>
          <Alert
            showIcon
            type={decisionAlertType(decision?.action_label)}
            message={decision?.conclusion || '选择目标日后生成投放建议'}
            description={
              decision
                ? `今天做决策，给明天投放策略；置信度：${confidenceLabel(decision.confidence)}；归因：${decision.diagnostics?.issue_label || '-'}；基线：${decision.baseline_from_date} ~ ${decision.baseline_to_date}，成熟口径 D${decision.maturity_day}。`
                : '系统会用截至昨天的成熟样本做基线，排除无打点、样本过小、转化异常和 LTV 未成熟的日期，再给出明天是否加投/观察/降预算。'
            }
          />

          {decision && (
            <>
              <Alert
                showIcon
                type="warning"
                message={`明日建议预算：${money(decision.budget_recommendation?.recommended_min_cny)} - ${money(decision.budget_recommendation?.recommended_max_cny)} 元`}
                description={
                  decision.budget_recommendation
                    ? `参考最近投放 ${money(decision.budget_recommendation.latest_recorded_spend_cny)} 元，成熟基线日均 ${money(decision.budget_recommendation.baseline_avg_spend_cny)} 元。预期 D30 收入 ${money(decision.budget_recommendation.expected_d30_revenue_cny)} 元，预期 D30 利润 ${money(decision.budget_recommendation.expected_d30_profit_cny)} 元。目标 CPI 不高于 ${money(decision.budget_recommendation.target_cpi_cny, 4)} 元；硬止损 CPI ${money(decision.budget_recommendation.hard_stop_cpi_cny, 4)} 元。`
                    : '暂无预算建议。'
                }
              />
              <Row gutter={[16, 16]}>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="建议最低预算" value={decision.budget_recommendation?.recommended_min_cny ?? 0} precision={2} />
                  </Card>
                </Col>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="建议最高预算" value={decision.budget_recommendation?.recommended_max_cny ?? 0} precision={2} />
                  </Card>
                </Col>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="预期 D30 利润" value={decision.budget_recommendation?.expected_d30_profit_cny ?? 0} precision={2} />
                  </Card>
                </Col>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="目标 CPI" value={decision.budget_recommendation?.target_cpi_cny ?? 0} precision={4} />
                  </Card>
                </Col>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="止损 CPI" value={decision.budget_recommendation?.hard_stop_cpi_cny ?? 0} precision={4} />
                  </Card>
                </Col>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="预期 D30 收入" value={decision.budget_recommendation?.expected_d30_revenue_cny ?? 0} precision={2} />
                  </Card>
                </Col>
              </Row>

              <Row gutter={[16, 16]}>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="基线有效天数" value={decision.baseline?.valid_sample_days ?? 0} />
                  </Card>
                </Col>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="排除异常天数" value={decision.baseline?.excluded_sample_days ?? 0} />
                  </Card>
                </Col>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="基线 CPI" value={decision.baseline?.avg_cpi_cny ?? 0} precision={4} />
                  </Card>
                </Col>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="基线 D30 LTV" value={decision.baseline?.weighted_d30_ltv_cny ?? 0} precision={4} />
                  </Card>
                </Col>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="基线预测 ROI" value={(decision.baseline?.predicted_d30_roi ?? 0) * 100} suffix="%" precision={1} />
                  </Card>
                </Col>
                <Col xs={12} md={4}>
                  <Card size="small">
                    <Statistic title="人均预测毛利" value={decision.baseline?.predicted_margin_per_user_cny ?? 0} precision={4} />
                  </Card>
                </Col>
              </Row>

              <Row gutter={[16, 16]}>
                <Col xs={24} md={12}>
                  <Card size="small" title="为什么">
                    <Space orientation="vertical">
                      {(decision.reasons || []).map((reason) => (
                        <Text key={reason}>{reason}</Text>
                      ))}
                    </Space>
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card size="small" title="下一步动作">
                    <Space orientation="vertical">
                      {(decision.next_steps || []).map((step) => (
                        <Text key={step}>{step}</Text>
                      ))}
                    </Space>
                  </Card>
                </Col>
              </Row>

              <Table
                rowKey="date_key"
                size="small"
                pagination={false}
                dataSource={decision.samples || []}
                columns={[
                  { title: '基线日期', dataIndex: 'date_key', width: 110 },
                  { title: '是否纳入', render: (_, row) => (row.included ? '纳入' : '排除'), width: 90 },
                  { title: '原因', dataIndex: 'reason' },
                  { title: '新增', dataIndex: 'game_new_users', width: 90 },
                  { title: 'CPI', render: (_, row) => money(row.cpi_cny, 4), width: 90 },
                  { title: 'D30 LTV', render: (_, row) => money(row.d30_projected_ltv_cny, 4), width: 100 },
                  { title: 'D30 ROI', render: (_, row) => percent(row.d30_projected_roi), width: 100 },
                ]}
              />
            </>
          )}
        </Space>
      </Card>

      <Card title="批量真实数据录入">
        <Form form={rangeForm} layout="vertical" onFinish={onGenerateRows}>
          <Row gutter={[16, 8]}>
            <Col xs={24} md={8}>
              <Form.Item label="日期范围" name="date_range" rules={[{ required: true, message: '请选择日期范围' }]}>
                <RangePicker style={{ width: '100%' }} allowClear={false} disabledDate={disableTodayAndFuture} />
              </Form.Item>
            </Col>
            <Col xs={24} md={16}>
              <Form.Item label=" " colon={false}>
                <Space>
                  <Button onClick={onUseLast7Days}>最近 7 天</Button>
                  <Button htmlType="submit">生成多行</Button>
                  <Button type="primary" loading={saving} onClick={onBatchSubmit}>
                    批量保存
                  </Button>
                  <Text type="secondary">已生成 {draftRows.length} 行，自动刷新不会覆盖未保存内容。</Text>
                </Space>
              </Form.Item>
            </Col>
          </Row>
        </Form>
        <Table
          rowKey="date_key"
          dataSource={draftRows}
          size="small"
          pagination={false}
          scroll={{ x: 900 }}
          columns={[
            { title: '日期', dataIndex: 'date_key', fixed: 'left', width: 110 },
            {
              title: '投放花费（元）',
              width: 150,
              render: (_, row: RoiDraftRow) => (
                <InputNumber
                  min={0}
                  precision={2}
                  value={row.spend_cny}
                  style={{ width: '100%' }}
                  onChange={(value) => updateDraftRow(row.date_key, { spend_cny: Number(value) || 0 })}
                />
              ),
            },
            {
              title: '微信点击次数',
              width: 150,
              render: (_, row: RoiDraftRow) => (
                <InputNumber
                  min={0}
                  precision={0}
                  value={row.wechat_clicks}
                  style={{ width: '100%' }}
                  onChange={(value) => updateDraftRow(row.date_key, { wechat_clicks: Number(value) || 0 })}
                />
              ),
            },
            {
              title: '微信真实收入（元）',
              width: 170,
              render: (_, row: RoiDraftRow) => (
                <InputNumber
                  min={0}
                  precision={2}
                  value={row.wechat_ad_revenue_cny}
                  style={{ width: '100%' }}
                  onChange={(value) => updateDraftRow(row.date_key, { wechat_ad_revenue_cny: Number(value) || 0 })}
                />
              ),
            },
            {
              title: '微信真实曝光（可选）',
              width: 150,
              render: (_, row: RoiDraftRow) => (
                <InputNumber
                  min={0}
                  precision={0}
                  value={row.wechat_ad_impressions}
                  style={{ width: '100%' }}
                  onChange={(value) => updateDraftRow(row.date_key, { wechat_ad_impressions: Number(value) || 0 })}
                />
              ),
            },
            {
              title: '备注',
              width: 220,
              render: (_, row: RoiDraftRow) => (
                <Input
                  value={row.note}
                  placeholder="可选"
                  onChange={(event) => updateDraftRow(row.date_key, { note: event.target.value })}
                />
              ),
            },
          ]}
        />
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={12} md={4}>
          <Card>
            <Statistic title="总花费" value={summary?.total_spend_cny ?? 0} precision={2} />
          </Card>
        </Col>
        <Col xs={12} md={4}>
          <Card>
            <Statistic title="微信真实收入" value={summary?.total_wechat_revenue_cny ?? 0} precision={2} />
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
    </Space>
  );
}

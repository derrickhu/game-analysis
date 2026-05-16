import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Card, Col, Empty, Result, Row, Space, Statistic, Table, Tooltip, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import ReactECharts from 'echarts-for-react';

import { getGameDescriptor } from '../../shared/games';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { buildWindowQuery, type WindowValue } from '../timeWindow';

const { Text, Title } = Typography;

interface LtvCohort {
  cohort_date: string;
  cohort_size: number;
  observed_days: number;
  ltv: {
    d0: number | null;
    d1: number | null;
    d3: number | null;
    d7: number | null;
    d14: number | null;
    d30: number | null;
    d30_projected: number | null;
    d60_projected: number | null;
  };
  retention: {
    d1: number | null;
    d3: number | null;
    d7: number | null;
    d14: number | null;
    d30: number | null;
  };
  revenue: {
    observed_cny: number;
    projected_d30_cny: number | null;
    projected_d60_cny: number | null;
  };
  points: Array<{
    age_day: number;
    ltv_cny: number;
    retention_rate: number;
    is_complete_day: boolean;
  }>;
}

interface LtvResponse {
  ok: boolean;
  query?: {
    game_key: string;
    from_date: string;
    to_date: string;
    window_minutes: number;
  };
  estimated?: true;
  notice?: string;
  cohorts?: LtvCohort[];
  summary?: {
    blended_ltv_d0: number | null;
    blended_ltv_d1: number | null;
    blended_ltv_d3: number | null;
    blended_ltv_d7: number | null;
    blended_ltv_d14: number | null;
    blended_ltv_d30: number | null;
    projected_ltv_d30: number | null;
    projected_ltv_d60: number | null;
    total_cohort_size: number;
    total_observed_revenue_cny: number;
    projection_method: string;
  };
  error?: string;
  code?: string;
}

interface MonetizationResponse {
  ok: boolean;
  query?: {
    game_key: string;
    from_date: string;
    to_date: string;
    window_minutes: number;
  };
  notice?: string;
  total_days?: number;
  active_user_days?: number;
  avg_dau?: number;
  dau?: number;
  new_users?: number;
  revenue_estimated_cny?: number;
  arpu_estimated_cny?: number;
  arpdau_estimated_cny?: number;
  ad_uau?: number;
  ad_penetration_rate?: number;
  ad_show_cnt?: number;
  ad_show_per_uu?: number;
  ipm?: number;
  fill_rate?: number;
  completion_rate?: number;
  error?: string;
  code?: string;
}

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return value.toFixed(4);
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function ratioPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${value.toFixed(1)}%`;
}

function projectionLabel(method: string | undefined): string {
  if (method === 'observed_only') return '已满观测期';
  if (method === 'ratio_d7') return 'D7 × 经验倍率';
  if (method === 'ratio_d3') return 'D3 × 经验倍率';
  return '样本不足';
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

/**
 * 通用 LTV / 商业化页面。
 * 所有查询都只依赖 gameKey + 标准事件，不写 hotpot 专属逻辑。
 */
export function LtvPage({ windowOverride }: { windowOverride?: WindowValue } = {}) {
  const {
    gameKey,
    windowSel,
    refreshToken,
    setLoading,
    setLastRefreshedAt,
  } = useAnalyticsFilter();
  const descriptor = getGameDescriptor(gameKey);
  const isIntegrated = descriptor?.hasAnalyticsSdk === true;
  const [ltv, setLtv] = useState<LtvResponse | null>(null);
  const [monetization, setMonetization] = useState<MonetizationResponse | null>(null);
  const requestSeqRef = useRef(0);
  const activeWindow = windowOverride || windowSel;

  const loadAll = useCallback(
    async (nextGameKey: string, nextWindow: WindowValue) => {
      const desc = getGameDescriptor(nextGameKey);
      if (!desc?.hasAnalyticsSdk) {
        setLtv(null);
        setMonetization(null);
        setLastRefreshedAt(Date.now());
        return;
      }
      const seq = ++requestSeqRef.current;
      setLoading(true);
      try {
        // 商业化页传入 windowOverride 时使用页内窗口；独立 LTV 路由才跟随顶部日期选择器。
        const queryStr = buildWindowQuery(nextWindow);
        const [ltvRes, monetizationRes] = await Promise.all([
          fetch(`/api/realtime/ltv?game=${encodeURIComponent(nextGameKey)}&${queryStr}`).then(
            (r) => r.json() as Promise<LtvResponse>,
          ),
          fetch(`/api/realtime/monetization?game=${encodeURIComponent(nextGameKey)}&${queryStr}`).then(
            (r) => r.json() as Promise<MonetizationResponse>,
          ),
        ]);
        if (seq !== requestSeqRef.current) return;
        if (!ltvRes.ok) message.error(`获取 LTV 失败: ${ltvRes.error || ltvRes.code}`);
        if (!monetizationRes.ok) {
          message.error(`获取商业化概览失败: ${monetizationRes.error || monetizationRes.code}`);
        }
        setLtv(ltvRes);
        setMonetization(monetizationRes);
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        message.error(`加载 LTV 页面失败: ${String(error)}`);
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [setLastRefreshedAt, setLoading],
  );

  useEffect(() => {
    void loadAll(gameKey, activeWindow);
  }, [gameKey, activeWindow, refreshToken, loadAll]);

  const chartOption = useMemo(() => {
    const cohorts = (ltv?.cohorts || []).slice(-30);
    const xAxis = Array.from({ length: 31 }, (_, i) => `D${i}`);
    return {
      tooltip: { trigger: 'axis' },
      legend: { top: 0, type: 'scroll' },
      grid: { left: 56, right: 24, top: 48, bottom: 56 },
      xAxis: { type: 'category', data: xAxis },
      yAxis: { type: 'value', name: '累计 LTV（元）' },
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        { type: 'slider', height: 18, bottom: 12, start: 0, end: 100 },
      ],
      series: cohorts.map((cohort) => {
        const pointMap = new Map(cohort.points.map((p) => [p.age_day, p.ltv_cny]));
        return {
          name: cohort.cohort_date,
          type: 'line',
          smooth: true,
          symbolSize: 5,
          data: xAxis.map((_, age) => pointMap.get(age) ?? null),
        };
      }),
    };
  }, [ltv]);

  const columns: ColumnsType<LtvCohort> = [
    {
      title: (
        <MetricTitle
          label="Cohort 日期"
          help="按用户在该游戏首次出现事件的本地自然日分组，用来对比不同新增批次的质量。"
        />
      ),
      dataIndex: 'cohort_date',
      fixed: 'left',
      width: 150,
    },
    {
      title: (
        <MetricTitle
          label="人数"
          help="该 cohort 的新增用户数，分母是首次出现于这一天的去重 user_key。样本越大，LTV 越稳定。"
        />
      ),
      dataIndex: 'cohort_size',
      width: 110,
    },
    {
      title: <MetricTitle label="D0 LTV" help="D0 当天累计估算收入 / cohort 人数，用来看首日变现效率。" />,
      render: (_, r) => money(r.ltv.d0),
      width: 120,
    },
    {
      title: <MetricTitle label="D1 LTV" help="D0~D1 累计估算收入 / cohort 人数，用来看次日留存后的早期回收。" />,
      render: (_, r) => money(r.ltv.d1),
      width: 120,
    },
    {
      title: <MetricTitle label="D3 LTV" help="D0~D3 累计估算收入 / cohort 人数，是当前数据量下最可靠的早期 LTV 观察点。" />,
      render: (_, r) => money(r.ltv.d3),
      width: 120,
    },
    {
      title: <MetricTitle label="D7 LTV" help="D0~D7 累计估算收入 / cohort 人数，用来判断一周回收。未满 7 天的 cohort 显示为空。" />,
      render: (_, r) => money(r.ltv.d7),
      width: 120,
    },
    {
      title: <MetricTitle label="D14 LTV" help="D0~D14 累计估算收入 / cohort 人数。当前数据未满 14 天时为空。" />,
      render: (_, r) => money(r.ltv.d14),
      width: 130,
    },
    {
      title: <MetricTitle label="D30 LTV" help="D0~D30 累计估算收入 / cohort 人数。当前数据未满 30 天时为空。" />,
      render: (_, r) => money(r.ltv.d30),
      width: 130,
    },
    {
      title: (
        <MetricTitle
          label="D30 预测"
          help="未满 30 天时用早期 LTV 外推：优先 D7×1.9，否则 D3×3.2。用于提前估算长期回收，不等同真实观测。"
        />
      ),
      render: (_, r) => <Text type="secondary">{money(r.ltv.d30_projected)}</Text>,
      width: 130,
    },
    {
      title: <MetricTitle label="D1 新增次留" help="新增 cohort 用户在第 1 天仍有业务活跃事件的人数 / cohort 新增人数。它是新增次留，不是“前一日活跃用户次日仍活跃”的活跃次留。" />,
      render: (_, r) => percent(r.retention.d1),
      width: 120,
    },
    {
      title: <MetricTitle label="D3 留存" help="cohort 用户在第 3 天仍有任意事件的人数 / cohort 人数，用来看短期粘性。" />,
      render: (_, r) => percent(r.retention.d3),
      width: 120,
    },
    {
      title: <MetricTitle label="D7 留存" help="cohort 用户在第 7 天仍有任意事件的人数 / cohort 人数，用来看一周留存。" />,
      render: (_, r) => percent(r.retention.d7),
      width: 120,
    },
    {
      title: (
        <MetricTitle
          label="累计估算收入"
          help="该 cohort 目前观测到的广告估算收入总和，计算方式为 ad_show × 预估 eCPM / 1000。"
        />
      ),
      render: (_, r) => r.revenue.observed_cny.toFixed(2),
      width: 150,
    },
  ];

  if (!isIntegrated) {
    return (
      <Result
        status="info"
        title={`${descriptor?.displayName ?? gameKey} 暂未接入打点 SDK`}
        subTitle="LTV 依赖标准事件流水，请先接入 @gp/analytics-sdk。"
      />
    );
  }

  const cohorts = ltv?.cohorts || [];
  const summary = ltv?.summary;
  const queryRange = ltv?.query || monetization?.query;
  const rangeLabel = queryRange ? `${queryRange.from_date} ~ ${queryRange.to_date}` : '-';

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message={`通用 LTV / 商业化指标 · 统计范围：${rangeLabel}`}
        description={
          <>
            <Text>
              本页所有顶部 KPI、商业化漏斗和 cohort 表都跟随顶部日期选择器。多日窗口里的 ARPDAU 使用
              「广告收入 / 活跃用户日」，单日窗口则等价于「当天广告收入 / 当天 DAU」。
            </Text>
            <br />
            <Text type="secondary">
              {ltv?.notice ||
                '所有游戏共用同一套 gameKey 口径；有真实 eCPM 的日期优先使用真实 eCPM，缺少真实收入/曝光时回退到预估 eCPM。'}
            </Text>
          </>
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title={
                <MetricTitle
                  label="广告收入（元）"
                  help={`统计范围：${rangeLabel}。计算方式：范围内广告曝光 × eCPM / 1000；若当天已录入微信真实收入和曝光，则使用当天真实 eCPM，否则使用 scene 预估 eCPM。用于快速看该时间段变现规模。`}
                />
              }
              value={monetization?.revenue_estimated_cny ?? 0}
              precision={2}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title={
                <MetricTitle
                  label="ARPDAU（元）"
                  help={`统计范围：${rangeLabel}。计算方式：范围估算收入 / 活跃用户日。若选单日，就是当天收入 / 当天 DAU；若选多日，则按每天活跃用户累加后的 user-day 做分母。作用：衡量每个日活用户每天的平均变现能力。`}
                />
              }
              value={monetization?.arpdau_estimated_cny ?? 0}
              precision={4}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title={
                <MetricTitle
                  label="D7 LTV（元）"
                  help={`Cohort 范围：${rangeLabel}。只统计首次出现日期落在该范围内、且已经满 7 天观测期的 cohort。计算方式：D0~D7 累计广告收入 / cohort 人数；有真实 eCPM 的日期用真实 eCPM，缺失时回退预估 eCPM。用于判断一周回收。`}
                />
              }
              value={summary?.blended_ltv_d7 ?? 0}
              precision={4}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title={
                <MetricTitle
                  label="D30 预测 LTV（元）"
                  help={`Cohort 范围：${rangeLabel}。当 D30 未满时用早期 LTV 经验倍率外推，优先 D7×1.9，否则 D3×3.2；真实 eCPM 会随你录入的数据逐步校准。用于提前评估长期回收。`}
                />
              }
              value={summary?.projected_ltv_d30 ?? 0}
              precision={4}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title={
                <MetricTitle
                  label="平均 DAU"
                  help={`统计范围：${rangeLabel}。计算方式：范围内活跃用户日 / 天数。比如 7 天窗口会把每天 DAU 加总后除以 7，用来代表这段时间的平均日活。`}
                />
              }
              value={monetization?.avg_dau ?? 0}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title={
                <MetricTitle
                  label="广告渗透率"
                  help={`统计范围：${rangeLabel}。计算方式：有广告曝光的用户日 / 活跃用户日。用于判断这段时间广告入口触达是否充分。`}
                />
              }
              value={monetization?.ad_penetration_rate ?? 0}
              suffix="%"
              precision={1}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title={
                <MetricTitle
                  label="IPM（千 DAU 曝光）"
                  help={`统计范围：${rangeLabel}。计算方式：广告曝光数 / 活跃用户日 × 1000。这里是曝光强度指标，不是 eCPM；用于衡量每千日活产生多少广告曝光。`}
                />
              }
              value={monetization?.ipm ?? 0}
              precision={1}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card>
            <Statistic
              title={
                <MetricTitle
                  label="完播率"
                  help={`统计范围：${rangeLabel}。计算方式：完整看完广告次数 / 广告曝光次数。用于判断激励视频质量和奖励是否能正常发放。`}
                />
              }
              value={monetization?.completion_rate ?? 0}
              suffix="%"
              precision={1}
            />
          </Card>
        </Col>
      </Row>

      <Card>
        <Title level={5}>商业化漏斗</Title>
        <Row gutter={[16, 16]}>
          <Col xs={8} md={4}>
            <Statistic
              title={
                <MetricTitle
                  label="窗口去重用户"
                  help={`统计范围：${rangeLabel}。计算方式：范围内有任意事件的去重用户数。用于看窗口覆盖的总用户规模；多日窗口不等同平均 DAU。`}
                />
              }
              value={monetization?.dau ?? 0}
            />
          </Col>
          <Col xs={8} md={4}>
            <Statistic
              title={
                <MetricTitle
                  label="广告触达用户"
                  help={`统计范围：${rangeLabel}。计算方式：范围内至少产生过一次 ad_show 的去重用户数。用于看有多少用户真的看到了广告。`}
                />
              }
              value={monetization?.ad_uau ?? 0}
            />
          </Col>
          <Col xs={8} md={4}>
            <Statistic
              title={
                <MetricTitle
                  label="广告曝光"
                  help={`统计范围：${rangeLabel}。计算方式：范围内 ad_show 事件总数。广告收入以这个数乘以当天真实/预估 eCPM 计算，是 IAA 变现的核心量。`}
                />
              }
              value={monetization?.ad_show_cnt ?? 0}
            />
          </Col>
          <Col xs={8} md={4}>
            <Statistic
              title={
                <MetricTitle
                  label="人均曝光"
                  help={`统计范围：${rangeLabel}。计算方式：广告曝光数 / 有广告曝光的用户日。用于判断看广告用户的观看频次。`}
                />
              }
              value={monetization?.ad_show_per_uu ?? 0}
              precision={2}
            />
          </Col>
          <Col xs={8} md={4}>
            <Statistic
              title={
                <MetricTitle
                  label="填充率"
                  help={`统计范围：${rangeLabel}。计算方式：广告曝光数 / 广告请求数。用于判断流量主是否有足够广告填充，低填充会直接损失收入。`}
                />
              }
              value={monetization?.fill_rate ?? 0}
              suffix="%"
              precision={1}
            />
          </Col>
          <Col xs={8} md={4}>
            <Statistic
              title={
                <MetricTitle
                  label="ARPU"
                  help={`统计范围：${rangeLabel}。计算方式：范围估算收入 / 范围去重用户数。用于看该时间段覆盖用户的人均收入；它和 ARPDAU 的区别是分母不是用户日。`}
                />
              }
              value={monetization?.arpu_estimated_cny ?? 0}
              precision={4}
            />
          </Col>
        </Row>
      </Card>

      <Card
        title={
          <MetricTitle
            label="LTV Cohort 曲线"
            help={`Cohort 范围：${rangeLabel}。每条线代表一个新增日期 cohort，横轴是注册后第 N 天，纵轴是累计 LTV；真实 eCPM 会随经营录入逐步校准。用于比较不同日期新增用户的长期价值走势。`}
          />
        }
      >
        {cohorts.length > 0 ? (
          <ReactECharts option={chartOption} style={{ height: 360 }} />
        ) : (
          <Empty description="暂无 LTV 回算数据，请先执行通用 LTV 回算" />
        )}
      </Card>

      <Card
        title={
          <MetricTitle
            label="LTV Cohort 表"
            help={`Cohort 范围：${rangeLabel}。按新增日期分组展示人数、累计 LTV、留存和收入；有真实 eCPM 的日期优先按真实 eCPM 计价，用来判断哪一天/哪批新增质量更好。`}
          />
        }
        extra={
          <MetricTitle
            label={`预测口径：${projectionLabel(summary?.projection_method)}`}
            help="预测值只用于早期决策参考；当真实 D7/D30 数据满足观测天数后，会优先展示 observed 实际值。"
          />
        }
      >
        <Table
          rowKey="cohort_date"
          columns={columns}
          dataSource={cohorts}
          size="small"
          scroll={{ x: 1300 }}
          pagination={{ pageSize: 10 }}
          summary={() => (
            <Table.Summary fixed>
              <Table.Summary.Row>
                <Table.Summary.Cell index={0}>加权汇总</Table.Summary.Cell>
                <Table.Summary.Cell index={1}>{summary?.total_cohort_size ?? 0}</Table.Summary.Cell>
                <Table.Summary.Cell index={2}>{money(summary?.blended_ltv_d0)}</Table.Summary.Cell>
                <Table.Summary.Cell index={3}>{money(summary?.blended_ltv_d1)}</Table.Summary.Cell>
                <Table.Summary.Cell index={4}>{money(summary?.blended_ltv_d3)}</Table.Summary.Cell>
                <Table.Summary.Cell index={5}>{money(summary?.blended_ltv_d7)}</Table.Summary.Cell>
                <Table.Summary.Cell index={6}>{money(summary?.blended_ltv_d14)}</Table.Summary.Cell>
                <Table.Summary.Cell index={7}>{money(summary?.blended_ltv_d30)}</Table.Summary.Cell>
                <Table.Summary.Cell index={8}>
                  <Text type="secondary">{money(summary?.projected_ltv_d30)}</Text>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={9}>-</Table.Summary.Cell>
                <Table.Summary.Cell index={10}>-</Table.Summary.Cell>
                <Table.Summary.Cell index={11}>-</Table.Summary.Cell>
                <Table.Summary.Cell index={12}>
                  {(summary?.total_observed_revenue_cny ?? 0).toFixed(2)}
                </Table.Summary.Cell>
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />
        <Text type="secondary">
          留存为新增 cohort 用户在对应 age day 仍有业务活跃事件的比例；这里展示的是新增留存，不是活跃用户次日回访留存。LTV 为 D0 到对应天数的累计广告收入 / cohort 人数。
          广告收入优先使用你录入的微信真实 eCPM，缺少真实收入/曝光时回退到预估 eCPM；后续接入 IAP 后可扩展 total_revenue。
        </Text>
      </Card>

      <Text type="secondary">
        当前窗口内：新增 {monetization?.new_users ?? 0} 人，活跃用户日 {monetization?.active_user_days ?? 0}，
        完播率 {ratioPercent(monetization?.completion_rate)}，填充率 {ratioPercent(monetization?.fill_rate)}。
      </Text>
    </Space>
  );
}

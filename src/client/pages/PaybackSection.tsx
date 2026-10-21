import { useEffect, useMemo, useState } from 'react';
import { Alert, Card, Col, Empty, Row, Space, Statistic, Table, Tooltip, Typography } from 'antd';
import ReactECharts from '../components/AnalyticsChart';

import { appendPlatformQuery, type PlatformFilter } from '../../shared/platforms';
import { fetchJson } from '../fetchJson';

const { Text } = Typography;

interface RoiRow {
  date_key: string;
  spend_cny: number;
  wechat_ad_revenue_cny: number;
  game_new_users: number;
  cpi_cny: number | null;
  d0_roi: number | null;
  d3_ltv_cny: number | null;
  d3_roi: number | null;
  d7_ltv_cny: number | null;
  d7_roi: number | null;
  d30_projected_ltv_cny: number | null;
  d30_projected_roi: number | null;
}

interface RoiResponse {
  ok: boolean;
  rows?: RoiRow[];
}

interface RetentionPoint {
  age_day: number;
  retained_users: number | null;
  retention_rate: number | null;
  is_complete_day: boolean;
}

interface RetentionCohort {
  cohort_date: string;
  overall: { cohort_size: number; points: RetentionPoint[] };
}

interface RetentionResponse {
  ok: boolean;
  cohorts?: RetentionCohort[];
}

interface LivePartial {
  cohort_date: string;
  age_day: number;
  retention_rate: number | null;
}

interface LiveTodayResponse {
  ok: boolean;
  date_key?: string;
  new_users?: number;
  spend_cny?: number;
  revenue_cny?: number;
  revenue_source?: 'publisher' | 'estimated';
  cpi_cny?: number | null;
  d0_roi?: number | null;
  partials?: LivePartial[];
  error?: string;
  code?: string;
}

interface DayRow {
  date_key: string;
  newUsers: number;
  spend: number;
  revenue: number;
  revenueLive: boolean;
  liveDay: boolean;
  d0Roi: number | null;
  d1: number | null;
  d1Ready: boolean;
  d1Live: boolean;
  d3: number | null;
  d3Ready: boolean;
  d3Live: boolean;
  d3Roi: number | null;
  d7: number | null;
  d7Ready: boolean;
  d7Live: boolean;
  d7Roi: number | null;
  d30Roi: number | null;
  cpi: number | null;
}

function dateKey(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return dateKey(date.getTime());
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function yuan(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return value.toFixed(2);
}

function pointAt(cohort: RetentionCohort | undefined, age: number): RetentionPoint | undefined {
  return cohort?.overall.points.find((point) => point.age_day === age);
}

function weighted(pairs: Array<{ value: number; weight: number }>): number | null {
  const weight = pairs.reduce((sum, item) => sum + item.weight, 0);
  if (weight <= 0) return null;
  return pairs.reduce((sum, item) => sum + item.value * item.weight, 0) / weight;
}

function retentionCell(ready: boolean, live: boolean, value: number | null) {
  if (ready) return percent(value);
  if (live && value !== null) {
    return (
      <Tooltip title="这一天还没过完，按当前已经回来的人现算，过完自然日会再定格。">
        <span>{percent(value)} <Text type="secondary">实时</Text></span>
      </Tooltip>
    );
  }
  return <Text type="secondary">未成熟</Text>;
}

function paybackText(row: DayRow): string {
  if (row.spend <= 0) return '未投放';
  if (row.d7Roi !== null && row.d7Roi >= 1) return '7 日已回本';
  if (row.d3Roi !== null && row.d3Roi >= 1) return '3 日已回本';
  if (row.d0Roi !== null && row.d0Roi >= 1) return '当天已回本';
  if (row.d30Roi !== null && row.d30Roi >= 1) return '预测 30 天能回本';
  if (row.d3Roi === null) return '观察中';
  return '还没回本';
}

export function PaybackSection({
  gameKey,
  platform,
  refreshToken,
}: {
  gameKey: string;
  platform: PlatformFilter;
  refreshToken: number;
}) {
  const [rows, setRows] = useState<DayRow[]>([]);
  const [ready, setReady] = useState(false);
  const [liveError, setLiveError] = useState('');

  useEffect(() => {
    const toDate = dateKey(Date.now() - 86_400_000);
    const fromDate = addDays(toDate, -13);
    let cancelled = false;
    setReady(false);
    setLiveError('');
    void (async () => {
      const roiQuery = appendPlatformQuery(
        `game=${encodeURIComponent(gameKey)}&from_date=${fromDate}&to_date=${toDate}`,
        platform,
      );
      const retentionQuery = appendPlatformQuery(
        `game=${encodeURIComponent(gameKey)}&from_date=${fromDate}&to_date=${toDate}&max_age=7`,
        platform,
      );
      const liveQuery = appendPlatformQuery(`game=${encodeURIComponent(gameKey)}`, platform);
      const [roi, retention, live] = await Promise.all([
        fetchJson<RoiResponse>(`/api/realtime/business-inputs?${roiQuery}`).catch((): RoiResponse => ({ ok: false })),
        fetchJson<RetentionResponse>(`/api/realtime/retention-cohorts?${retentionQuery}`).catch((): RetentionResponse => ({ ok: false })),
        fetchJson<LiveTodayResponse>(`/api/realtime/payback-today?${liveQuery}`).catch((): LiveTodayResponse => ({ ok: false })),
      ]);
      if (cancelled) return;
      const roiByDate = new Map((roi.rows || []).map((row) => [row.date_key, row]));
      const cohortByDate = new Map((retention.cohorts || []).map((row) => [row.cohort_date, row]));
      const dates = new Set<string>([...roiByDate.keys(), ...cohortByDate.keys()]);
      const next = [...dates]
        .filter((date) => date >= fromDate && date <= toDate)
        .sort((a, b) => b.localeCompare(a))
        .map((date) => {
          const money = roiByDate.get(date);
          const cohort = cohortByDate.get(date);
          const d1 = pointAt(cohort, 1);
          const d3 = pointAt(cohort, 3);
          const d7 = pointAt(cohort, 7);
          return {
            date_key: date,
            newUsers: money?.game_new_users || cohort?.overall.cohort_size || 0,
            spend: Number(money?.spend_cny || 0),
            revenue: Number(money?.wechat_ad_revenue_cny || 0),
            revenueLive: false,
            liveDay: false,
            d0Roi: money?.d0_roi ?? null,
            d1: d1?.is_complete_day ? d1.retention_rate : null,
            d1Ready: Boolean(d1?.is_complete_day),
            d1Live: false,
            d3: d3?.is_complete_day ? d3.retention_rate : null,
            d3Ready: Boolean(d3?.is_complete_day),
            d3Live: false,
            d3Roi: money?.d3_roi ?? null,
            d7: d7?.is_complete_day ? d7.retention_rate : null,
            d7Ready: Boolean(d7?.is_complete_day),
            d7Live: false,
            d7Roi: money?.d7_roi ?? null,
            d30Roi: money?.d30_projected_roi ?? null,
            cpi: money?.cpi_cny ?? null,
          };
        });
      if (live.ok && live.date_key) {
        for (const partial of live.partials || []) {
          const row = next.find((item) => item.date_key === partial.cohort_date);
          if (!row || partial.retention_rate === null) continue;
          if (partial.age_day === 1 && !row.d1Ready) {
            row.d1 = partial.retention_rate;
            row.d1Live = true;
          } else if (partial.age_day === 3 && !row.d3Ready) {
            row.d3 = partial.retention_rate;
            row.d3Live = true;
          } else if (partial.age_day === 7 && !row.d7Ready) {
            row.d7 = partial.retention_rate;
            row.d7Live = true;
          }
        }
        next.unshift({
          date_key: live.date_key,
          newUsers: live.new_users || 0,
          spend: Number(live.spend_cny || 0),
          revenue: Number(live.revenue_cny || 0),
          revenueLive: live.revenue_source !== 'publisher',
          liveDay: true,
          d0Roi: live.d0_roi ?? null,
          d1: null,
          d1Ready: false,
          d1Live: false,
          d3: null,
          d3Ready: false,
          d3Live: false,
          d3Roi: null,
          d7: null,
          d7Ready: false,
          d7Live: false,
          d7Roi: null,
          d30Roi: null,
          cpi: live.cpi_cny ?? null,
        });
        setLiveError('');
      } else {
        setLiveError(live.error || live.code || '今天的留存和回本没有算出来');
      }
      setRows(next);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [gameKey, platform, refreshToken]);

  const summary = useMemo(() => {
    const spend = rows.reduce((sum, row) => sum + row.spend, 0);
    const revenue = rows.reduce((sum, row) => sum + row.revenue, 0);
    const d1 = weighted(rows.filter((row) => row.d1Ready && row.d1 !== null).map((row) => ({ value: row.d1 as number, weight: row.newUsers })));
    const d3Roi = weighted(
      rows
        .filter((row) => row.d3Roi !== null && row.spend > 0)
        .map((row) => ({ value: row.d3Roi as number, weight: row.spend })),
    );
    const d30Roi = weighted(
      rows
        .filter((row) => row.d30Roi !== null && row.spend > 0)
        .map((row) => ({ value: row.d30Roi as number, weight: row.spend })),
    );
    return {
      spend,
      revenue,
      d0: spend > 0 ? revenue / spend : null,
      d1,
      d3Roi,
      d30Roi,
    };
  }, [rows]);

  const chart = useMemo(() => {
    const ordered = [...rows].sort((a, b) => a.date_key.localeCompare(b.date_key));
    return {
      tooltip: { trigger: 'axis' as const },
      legend: { data: ['D1 留存', '当天回收', 'D3 回收'] },
      grid: { left: 16, right: 16, top: 48, bottom: 24, containLabel: true },
      xAxis: { type: 'category' as const, data: ordered.map((row) => row.date_key.slice(5)) },
      yAxis: [
        { type: 'value' as const, name: '留存 %', min: 0 },
        { type: 'value' as const, name: '回收 %', min: 0, splitLine: { show: false } },
      ],
      series: [
        {
          name: 'D1 留存',
          type: 'line' as const,
          smooth: true,
          data: ordered.map((row) => (row.d1 === null ? null : Math.round(row.d1 * 1000) / 10)),
        },
        {
          name: '当天回收',
          type: 'line' as const,
          yAxisIndex: 1,
          smooth: true,
          data: ordered.map((row) => (row.d0Roi === null ? null : Math.round(row.d0Roi * 1000) / 10)),
        },
        {
          name: 'D3 回收',
          type: 'line' as const,
          yAxisIndex: 1,
          smooth: true,
          data: ordered.map((row) => (row.d3Roi === null ? null : Math.round(row.d3Roi * 1000) / 10)),
        },
      ],
    };
  }, [rows]);

  const verdict = (() => {
    if (!ready) return null;
    if (summary.spend <= 0) {
      return {
        type: 'info' as const,
        title: '最近 14 天还没有读到投放消耗',
        detail: '投放账号接上之后，这里按天看新增留存，以及收入能不能盖住消耗。留存跟着上面的渠道，消耗是腾讯广告账号当天的总数。',
      };
    }
    const recoveredToday = summary.d0 !== null && summary.d0 >= 1;
    const recoveredIn3Days = summary.d3Roi !== null && summary.d3Roi >= 1;
    if (recoveredToday || recoveredIn3Days) {
      return {
        type: 'success' as const,
        title: recoveredToday ? '这段投放当天已经收回成本' : '已出数的 3 日回收已经盖住获客成本',
        detail: `含今天，消耗 ${yuan(summary.spend)} 元，收入 ${yuan(summary.revenue)} 元。`,
      };
    }
    if (summary.d30Roi !== null && summary.d30Roi >= 1) {
      return {
        type: 'warning' as const,
        title: '现在还没回本，按现有留存和变现，预测 30 天可以收回',
        detail: `含今天，消耗 ${yuan(summary.spend)} 元，当天收回 ${percent(summary.d0)}。预测 30 日回收 ${percent(summary.d30Roi)}。`,
      };
    }
    return {
      type: 'warning' as const,
      title: '最近这段投放还没回本',
      detail: `含今天，消耗 ${yuan(summary.spend)} 元，收入 ${yuan(summary.revenue)} 元，当天收回 ${percent(summary.d0)}。已出数的 3 日回收是 ${percent(summary.d3Roi)}。`,
    };
  })();

  return (
    <Card
      title="留存与回本"
      extra={<Text type="secondary">近 14 天加上今天。今天还没过完，留存和回收按当前累计，标成实时。</Text>}
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        {liveError && (
          <Alert type="error" showIcon title="今天的留存和回本没有算出来" description={liveError} />
        )}
        {verdict && (
          <Alert
            type={verdict.type}
            showIcon
            title={verdict.title}
            description={verdict.detail}
          />
        )}
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic title="投放消耗" value={yuan(summary.spend)} suffix="元" />
          </Col>
          <Col xs={12} md={6}>
            <Tooltip title="已过完的日期用流量主结算收入。今天还没结算时，用近期真实 eCPM 乘以当前曝光。">
              <Statistic title="收入" value={yuan(summary.revenue)} suffix="元" />
            </Tooltip>
          </Col>
          <Col xs={12} md={4}>
            <Tooltip title="窗口内流量主真实收入 ÷ 投放消耗。">
              <Statistic title="当天回收" value={summary.d0 === null ? '-' : (summary.d0 * 100).toFixed(1)} suffix={summary.d0 === null ? undefined : '%'} />
            </Tooltip>
          </Col>
          <Col xs={12} md={4}>
            <Tooltip title="近 14 天里已经过完次日的新增用户，按人数加权的次留。">
              <Statistic title="加权次留" value={summary.d1 === null ? '-' : (summary.d1 * 100).toFixed(1)} suffix={summary.d1 === null ? undefined : '%'} />
            </Tooltip>
          </Col>
          <Col xs={12} md={4}>
            <Tooltip title="已经满 3 天的投放日，按消耗加权的 3 日 LTV / CPI。没满 3 天的不参与。">
              <Statistic title="3 日回收" value={summary.d3Roi === null ? '-' : (summary.d3Roi * 100).toFixed(1)} suffix={summary.d3Roi === null ? undefined : '%'} />
            </Tooltip>
          </Col>
        </Row>
        {rows.length > 0 ? (
          <ReactECharts option={chart} style={{ height: 260 }} />
        ) : (
          ready && <Empty description="这段时间还没有留存或投放数据" />
        )}
        <Table
          rowKey="date_key"
          size="small"
          pagination={false}
          scroll={{ x: 980 }}
          dataSource={rows}
          columns={[
            {
              title: '日期',
              dataIndex: 'date_key',
              width: 120,
              render: (value: string, row: DayRow) => (row.liveDay ? `${value.slice(5)} 今天` : value.slice(5)),
            },
            { title: '新增', dataIndex: 'newUsers', align: 'right', width: 80 },
            { title: '消耗', align: 'right', width: 90, render: (_, row: DayRow) => yuan(row.spend) },
            {
              title: '收入',
              align: 'right',
              width: 90,
              render: (_, row: DayRow) => (
                row.revenueLive ? (
                  <Tooltip title="今天流量主还没结算。按近 14 天真实 eCPM 乘以当前广告曝光估算。">
                    <span>{yuan(row.revenue)}</span>
                  </Tooltip>
                ) : yuan(row.revenue)
              ),
            },
            { title: 'CPI', align: 'right', width: 80, render: (_, row: DayRow) => (row.spend > 0 && row.cpi !== null ? row.cpi.toFixed(2) : '-') },
            { title: '当天回收', align: 'right', width: 90, render: (_, row: DayRow) => percent(row.d0Roi) },
            {
              title: '次留',
              align: 'right',
              width: 80,
              render: (_, row: DayRow) => retentionCell(row.d1Ready, row.d1Live, row.d1),
            },
            {
              title: '3 留',
              align: 'right',
              width: 80,
              render: (_, row: DayRow) => retentionCell(row.d3Ready, row.d3Live, row.d3),
            },
            { title: '3 日回收', align: 'right', width: 90, render: (_, row: DayRow) => (row.d3Roi === null ? <Text type="secondary">未成熟</Text> : percent(row.d3Roi)) },
            {
              title: '7 留',
              align: 'right',
              width: 80,
              render: (_, row: DayRow) => retentionCell(row.d7Ready, row.d7Live, row.d7),
            },
            { title: '7 日回收', align: 'right', width: 90, render: (_, row: DayRow) => (row.d7Roi === null ? <Text type="secondary">未成熟</Text> : percent(row.d7Roi)) },
            { title: '回本', width: 140, render: (_, row: DayRow) => paybackText(row) },
          ]}
        />
      </Space>
    </Card>
  );
}

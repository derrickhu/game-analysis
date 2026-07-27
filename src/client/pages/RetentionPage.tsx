import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  DatePicker,
  Empty,
  Result,
  Row,
  Select,
  Spin,
  Space,
  Statistic,
  Table,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import ReactECharts from '../components/AnalyticsChart';
import type { ReactNode } from 'react';

import { getGameDescriptor } from '../../shared/games';
import type { PlatformFilter } from '../../shared/platforms';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';

const { Text } = Typography;
const { RangePicker } = DatePicker;

type DeviceType = 'iOS' | 'Android' | 'HarmonyOS' | 'iPad' | 'Android Pad' | 'Unknown';
type SegmentType = DeviceType | '整体';

interface RetentionPoint {
  age_day: number;
  retained_users: number | null;
  retention_rate: number | null;
  is_complete_day: boolean;
}

interface RetentionSegment {
  device_type: SegmentType;
  cohort_size: number;
  points: RetentionPoint[];
}

interface RetentionCohort {
  cohort_date: string;
  overall: RetentionSegment;
  devices: RetentionSegment[];
}

interface PlatformRetentionRow {
  device_type: SegmentType;
  cohort_size: number;
  d1: number | null;
  d2: number | null;
  d3: number | null;
  d7: number | null;
}

interface RetentionRangeResponse {
  ok: boolean;
  from_date?: string;
  to_date?: string;
  max_age?: number;
  updated_at?: number;
  notice?: string;
  cohorts?: RetentionCohort[];
  code?: string;
  error?: string;
}

function defaultRange(): [Dayjs, Dayjs] {
  const yesterday = dayjs().subtract(1, 'day');
  return [yesterday.subtract(13, 'day'), yesterday];
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function retentionCell(point: RetentionPoint | undefined, cohortSize: number): ReactNode {
  if (!point?.is_complete_day) return <Text type="secondary">未成熟</Text>;
  if (point.retention_rate === null || point.retention_rate === undefined) return '-';
  return (
    <Space direction="vertical" size={0}>
      <Text>{percent(point.retention_rate)}</Text>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {point.retained_users ?? 0}/{cohortSize} 人
      </Text>
    </Space>
  );
}

function pointAt(segment: RetentionSegment | undefined, ageDay: number): RetentionPoint | undefined {
  return segment?.points.find((point) => point.age_day === ageDay);
}

function segmentFor(cohort: RetentionCohort, segment: SegmentType): RetentionSegment | undefined {
  if (segment === '整体') return cohort.overall;
  return cohort.devices.find((item) => item.device_type === segment);
}

function avgRate(cohorts: RetentionCohort[], ageDay: number, segment: SegmentType): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const cohort of cohorts) {
    const seg = segmentFor(cohort, segment);
    const point = pointAt(seg, ageDay);
    if (!seg || point?.retention_rate === null || point?.retention_rate === undefined) continue;
    numerator += point.retention_rate * seg.cohort_size;
    denominator += seg.cohort_size;
  }
  return denominator > 0 ? numerator / denominator : null;
}

function totalCohortSize(cohorts: RetentionCohort[], segment: SegmentType): number {
  return cohorts.reduce((sum, cohort) => sum + (segmentFor(cohort, segment)?.cohort_size || 0), 0);
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

function heatColor(value: number | null | undefined): string {
  if (value === null || value === undefined) return '#eef2f7';
  if (value >= 0.15) return '#6ee7b7';
  if (value >= 0.08) return '#a7f3d0';
  if (value >= 0.04) return '#bfdbfe';
  return '#fecdd3';
}

async function fetchRetentionRange(
  gameKey: string,
  range: [Dayjs, Dayjs],
  platform: PlatformFilter,
): Promise<RetentionRangeResponse> {
  const query = new URLSearchParams({
    game: gameKey,
    from_date: range[0].format('YYYY-MM-DD'),
    to_date: range[1].format('YYYY-MM-DD'),
    max_age: '30',
    platform,
  });
  const res = await fetch(`/api/realtime/retention-cohorts?${query.toString()}`);
  return (await res.json()) as RetentionRangeResponse;
}

export function RetentionPage() {
  const { gameKey, platform, refreshToken, setLoading, setLastRefreshedAt } = useAnalyticsFilter();
  const descriptor = getGameDescriptor(gameKey);
  const isIntegrated = descriptor?.hasAnalyticsSdk === true;
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultRange);
  const [data, setData] = useState<RetentionRangeResponse | null>(null);
  const [segment, setSegment] = useState<SegmentType>('整体');
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const lastRequestKeyRef = useRef('');

  const loadData = useCallback(
    async (nextGameKey: string, nextRange: [Dayjs, Dayjs]) => {
      if (!getGameDescriptor(nextGameKey)?.hasAnalyticsSdk) {
        setData(null);
        setLastRefreshedAt(Date.now());
        return;
      }
      const requestKey = `${nextGameKey}|${nextRange[0].format('YYYY-MM-DD')}|${nextRange[1].format('YYYY-MM-DD')}`;
      lastRequestKeyRef.current = requestKey;
      setPageLoading(true);
      setLoadError(null);
      setLoading(true);
      try {
        const json = await fetchRetentionRange(nextGameKey, nextRange, platform);
        if (lastRequestKeyRef.current !== requestKey) return;
        if (!json.ok) {
          const err = `获取留存数据失败: ${json.error || json.code}`;
          setLoadError(err);
          message.error(err);
          return;
        }
        setData(json);
        if (json.from_date && json.to_date) {
          const normalizedRange = [dayjs(json.from_date), dayjs(json.to_date)] as [Dayjs, Dayjs];
          if (
            normalizedRange[0].format('YYYY-MM-DD') !== nextRange[0].format('YYYY-MM-DD') ||
            normalizedRange[1].format('YYYY-MM-DD') !== nextRange[1].format('YYYY-MM-DD')
          ) {
            setRange(normalizedRange);
          }
        }
        const cohorts = json.cohorts || [];
        setSelectedDate((prev) =>
          prev && cohorts.some((cohort) => cohort.cohort_date === prev)
            ? prev
            : cohorts[cohorts.length - 1]?.cohort_date || null,
        );
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (lastRequestKeyRef.current !== requestKey) return;
        const err = `加载留存分析失败: ${String(error)}`;
        setLoadError(err);
        message.error(err);
      } finally {
        if (lastRequestKeyRef.current === requestKey) {
          setPageLoading(false);
          setLoading(false);
        }
      }
    },
    [platform, setLastRefreshedAt, setLoading],
  );

  useEffect(() => {
    void loadData(gameKey, range);
  }, [gameKey, platform, loadData, refreshToken]);

  const cohorts = data?.cohorts || [];
  const selectedCohort = cohorts.find((cohort) => cohort.cohort_date === selectedDate) || cohorts[cohorts.length - 1];
  const deviceTypes = useMemo(() => {
    const set = new Set<SegmentType>(['整体']);
    for (const cohort of cohorts) {
      for (const device of cohort.devices) set.add(device.device_type);
    }
    return Array.from(set);
  }, [cohorts]);

  const d1Avg = avgRate(cohorts, 1, segment);
  const d2Avg = avgRate(cohorts, 2, segment);
  const d3Avg = avgRate(cohorts, 3, segment);
  const d7Avg = avgRate(cohorts, 7, segment);
  const totalUsers = cohorts.reduce((sum, cohort) => sum + (segmentFor(cohort, segment)?.cohort_size || 0), 0);
  const platformRows: PlatformRetentionRow[] = useMemo(
    () =>
      deviceTypes.map((deviceType) => ({
        device_type: deviceType,
        cohort_size: totalCohortSize(cohorts, deviceType),
        d1: avgRate(cohorts, 1, deviceType),
        d2: avgRate(cohorts, 2, deviceType),
        d3: avgRate(cohorts, 3, deviceType),
        d7: avgRate(cohorts, 7, deviceType),
      })),
    [cohorts, deviceTypes],
  );

  const trendOption = useMemo(() => {
    const xAxis = cohorts.map((cohort) => cohort.cohort_date.slice(5));
    const buildSeries = (ageDay: number, name: string) => ({
      name,
      type: 'line',
      smooth: true,
      symbolSize: 6,
      data: cohorts.map((cohort) => {
        const point = pointAt(segmentFor(cohort, segment), ageDay);
        const rate = point?.is_complete_day ? point.retention_rate : null;
        return rate === null || rate === undefined ? null : Number((rate * 100).toFixed(2));
      }),
    });
    return {
      tooltip: { trigger: 'axis', valueFormatter: (value: number | string) => (typeof value === 'number' ? `${value.toFixed(1)}%` : value) },
      legend: { top: 0 },
      grid: { left: 16, right: 20, top: 48, bottom: 28, containLabel: true },
      xAxis: { type: 'category', data: xAxis },
      yAxis: { type: 'value', name: '留存率', axisLabel: { formatter: '{value}%' } },
      series: [
        { ...buildSeries(1, 'D1 新增次留'), areaStyle: { opacity: 0.12 } },
        buildSeries(2, 'D2 留存'),
        buildSeries(3, 'D3 留存'),
        buildSeries(7, 'D7 留存'),
      ],
    };
  }, [cohorts, segment]);

  const detailOption = useMemo(() => {
    const xAxis = Array.from({ length: (data?.max_age ?? 30) + 1 }, (_, age) => `D${age}`);
    const segments = selectedCohort ? [selectedCohort.overall, ...selectedCohort.devices.slice(0, 5)] : [];
    return {
      tooltip: { trigger: 'axis', valueFormatter: (value: number | string) => (typeof value === 'number' ? `${value.toFixed(1)}%` : value) },
      legend: { top: 0 },
      grid: { left: 16, right: 20, top: 48, bottom: 52, containLabel: true },
      xAxis: { type: 'category', data: xAxis },
      yAxis: { type: 'value', name: '留存率', axisLabel: { formatter: '{value}%' } },
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        { type: 'slider', height: 20, bottom: 8, start: 0, end: 100 },
      ],
      series: segments.map((seg) => ({
        name: seg.device_type,
        type: 'line',
        smooth: true,
        symbolSize: seg.device_type === '整体' ? 7 : 5,
        data: xAxis.map((_, age) => {
          const rate = pointAt(seg, age)?.retention_rate;
          return rate === null || rate === undefined ? null : Number((rate * 100).toFixed(2));
        }),
      })),
    };
  }, [data?.max_age, selectedCohort]);

  const matrixColumns: ColumnsType<RetentionCohort> = [
    { title: 'Cohort 日期', dataIndex: 'cohort_date', fixed: 'left', width: 120 },
    {
      title: '新增人数',
      width: 100,
      render: (_, row) => {
        const size = segmentFor(row, segment)?.cohort_size || 0;
        return (
          <Space direction="vertical" size={0}>
            <Text>{size}</Text>
            {size > 0 && size < 100 ? <Text type="secondary" style={{ fontSize: 12 }}>样本小</Text> : null}
          </Space>
        );
      },
    },
    ...[1, 2, 3, 7, 14, 30].map((age) => ({
      title: `D${age}`,
      width: 96,
      render: (_: unknown, row: RetentionCohort) => {
        const seg = segmentFor(row, segment);
        const point = pointAt(seg, age);
        const rate = point?.retention_rate;
        return (
          <div style={{ background: heatColor(rate), padding: '4px 8px', borderRadius: 4, textAlign: 'center' }}>
            {retentionCell(point, seg?.cohort_size || 0)}
          </div>
        );
      },
    })),
  ];

  if (!isIntegrated) {
    return (
      <Result
        status="info"
        title={`${descriptor?.displayName ?? gameKey} 暂未接入打点 SDK`}
        subTitle="留存分析依赖标准事件流水，请先接入 @gp/analytics-sdk。"
      />
    );
  }

  const retentionHelp =
    data?.notice ||
    '看多天新增 cohort 的 D1/D7 趋势与矩阵；点矩阵行可钻取 D0-D30。按 session_start 去重，是新增留存，不是活跃次留。';
  const matrixHelp =
    '行=新增日期 cohort（该日首次 session_start 人数）；列=这批人在第 N 天是否再次 session_start。格子第一行留存率、第二行回访/新增。未成熟格子不参与均值。≠ 活跃次留。';

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {loadError && <Alert type="warning" showIcon message={loadError} />}

      <Card
        title={
          <MetricTitle
            label={`留存筛选 · ${descriptor?.displayName ?? gameKey}`}
            help={`${retentionHelp} ${matrixHelp}`}
          />
        }
        extra={
          <Text type="secondary">
            {data?.from_date || '-'} ~ {data?.to_date || '-'} · {cohorts.length} cohort · {segment}
          </Text>
        }
      >
        <Space wrap>
          <RangePicker
            allowClear={false}
            value={range}
            disabledDate={(date) => !date || date.isSame(dayjs(), 'day') || date.isAfter(dayjs(), 'day')}
            onChange={(value) => {
              if (!value || !value[0] || !value[1]) return;
              const days = value[1].startOf('day').diff(value[0].startOf('day'), 'day') + 1;
              if (days > 31) {
                message.warning('一次最多看 31 天 cohort，避免页面过慢');
                return;
              }
              const nextRange = [value[0], value[1]] as [Dayjs, Dayjs];
              setRange(nextRange);
              void loadData(gameKey, nextRange);
            }}
            presets={[
              { label: '近 7 天', value: [dayjs().subtract(7, 'day'), dayjs().subtract(1, 'day')] as [Dayjs, Dayjs] },
              { label: '近 14 天', value: defaultRange() },
              { label: '近 30 天', value: [dayjs().subtract(30, 'day'), dayjs().subtract(1, 'day')] as [Dayjs, Dayjs] },
            ]}
          />
          <Select
            value={segment}
            options={deviceTypes.map((item) => ({ value: item, label: item }))}
            onChange={(value) => setSegment(value as SegmentType)}
            style={{ width: 180 }}
          />
          <Button onClick={() => void loadData(gameKey, range)}>刷新</Button>
        </Space>
      </Card>

      <Spin spinning={pageLoading} tip="正在加载 cohort 留存数据...">
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card className="kpi-card">
            <Tooltip title="筛选范围内各 cohort 新增人数之和（当前平台维度）">
              <Statistic title="范围 Cohort 人数" value={totalUsers} suffix="人" />
            </Tooltip>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="kpi-card">
            <Tooltip title="各成熟 cohort 的 D1 新增次留，按 cohort 人数加权平均">
              <Statistic title="平均 D1 新增次留" value={d1Avg !== null ? d1Avg * 100 : 0} suffix="%" precision={1} />
            </Tooltip>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="kpi-card">
            <Tooltip title={d2Avg === null ? '暂无成熟 D2' : '各成熟 cohort 的 D2 留存，按人数加权平均'}>
              <Statistic title="平均 D2 留存" value={d2Avg !== null ? d2Avg * 100 : 0} suffix="%" precision={1} />
            </Tooltip>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card className="kpi-card">
            <Tooltip title={d3Avg === null ? '暂无成熟 D3' : '各成熟 cohort 的 D3 留存，按人数加权平均'}>
              <Statistic title="平均 D3 留存" value={d3Avg !== null ? d3Avg * 100 : 0} suffix="%" precision={1} />
            </Tooltip>
          </Card>
        </Col>
      </Row>

      <Card
        title={
          <MetricTitle
            label={`多天留存趋势 · ${segment}`}
            help="各 cohort 在 D1/D2/D3/D7 的新增留存率走势；未成熟天数不参与判断。"
          />
        }
      >
        {cohorts.length > 0 ? <ReactECharts option={trendOption} style={{ height: 320 }} /> : <Empty description="暂无 cohort 数据" />}
      </Card>

      <Card
        title={
          <MetricTitle
            label={`Cohort 新增留存矩阵 · ${segment}`}
            help="行是新增日期 cohort，新增人数就是这一行日期当天首次 session_start 的人数；列是这批新用户在后续第 N 天是否再次 session_start。这里不是活跃次留。"
          />
        }
      >
        <Table
          rowKey="cohort_date"
          columns={matrixColumns}
          dataSource={cohorts}
          size="small"
          pagination={false}
          scroll={{ x: 900 }}
          onRow={(record) => ({
            onClick: () => setSelectedDate(record.cohort_date),
            style: { cursor: 'pointer', background: record.cohort_date === selectedDate ? '#e0f2fe' : undefined },
          })}
        />
      </Card>

      <Card
        title={
          <MetricTitle
            label="平台留存对比（范围加权）"
            help="不用筛选，直接对比范围内整体、Android、iOS、iPad、Android Pad 等平台的加权平均留存。分母为该平台在范围内的 cohort 新增人数总和。"
          />
        }
      >
        <Table
          rowKey="device_type"
          columns={[
            { title: '平台', dataIndex: 'device_type', fixed: 'left', width: 130 },
            { title: '新增人数', dataIndex: 'cohort_size', width: 120 },
            { title: '平均 D1', render: (_, row: PlatformRetentionRow) => percent(row.d1), width: 120 },
            { title: '平均 D2', render: (_, row: PlatformRetentionRow) => percent(row.d2), width: 120 },
            { title: '平均 D3', render: (_, row: PlatformRetentionRow) => percent(row.d3), width: 120 },
            { title: '平均 D7', render: (_, row: PlatformRetentionRow) => percent(row.d7), width: 120 },
            {
              title: '判断',
              render: (_, row: PlatformRetentionRow) =>
                row.cohort_size < 100 ? <Text type="secondary">样本小</Text> : <Text>可参考</Text>,
              width: 100,
            },
          ]}
          dataSource={platformRows}
          size="small"
          pagination={false}
          scroll={{ x: 900 }}
        />
      </Card>

      <Collapse
        items={[
          {
            key: 'detail',
            label: `单日钻取详情：${selectedCohort?.cohort_date || '-'} 新增用户后续留存`,
            children: selectedCohort ? (
              <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
                <ReactECharts option={detailOption} style={{ height: 360 }} />
                <Table
                  rowKey="device_type"
                  columns={[
                    { title: '设备类型', dataIndex: 'device_type', fixed: 'left', width: 130 },
                    { title: 'Cohort 人数', dataIndex: 'cohort_size', width: 120 },
                    { title: 'D1', render: (_, row: RetentionSegment) => retentionCell(pointAt(row, 1), row.cohort_size), width: 120 },
                    { title: 'D3', render: (_, row: RetentionSegment) => retentionCell(pointAt(row, 3), row.cohort_size), width: 120 },
                    { title: 'D7', render: (_, row: RetentionSegment) => retentionCell(pointAt(row, 7), row.cohort_size), width: 120 },
                    { title: 'D14', render: (_, row: RetentionSegment) => retentionCell(pointAt(row, 14), row.cohort_size), width: 120 },
                    { title: 'D30', render: (_, row: RetentionSegment) => retentionCell(pointAt(row, 30), row.cohort_size), width: 120 },
                    {
                      title: '判断',
                      render: (_, row: RetentionSegment) => (row.cohort_size < 30 ? <Text type="secondary">样本不足</Text> : <Text>可参考</Text>),
                      width: 100,
                    },
                  ]}
                  dataSource={[selectedCohort.overall, ...selectedCohort.devices]}
                  size="small"
                  pagination={false}
                  scroll={{ x: 900 }}
                />
              </Space>
            ) : (
              <Empty description="点击上方矩阵中的某一天查看单日详情" />
            ),
          },
        ]}
      />
      </Spin>
    </Space>
  );
}

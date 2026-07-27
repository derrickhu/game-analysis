import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Col, Empty, Row, Space, Statistic, Table, Tooltip, Typography, message } from 'antd';
import ReactECharts from '../components/AnalyticsChart';

import { appendPlatformQuery } from '../../shared/platforms';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { buildWindowQuery, type WindowValue } from '../timeWindow';

import {
  CHART_GRID_WITH_ZOOM,
  CHART_LEGEND_TOP,
  bucketShort,
  defaultZoomStart,
  formatInt,
  formatPercent,
  makeDataZoom,
} from './utils';

const { Text } = Typography;

interface OrderTierRow {
  tier: string;
  spawn_cnt: number;
  deliver_cnt: number;
  expire_cnt: number;
  ditch_cnt: number;
  deliver_rate: number | null;
}

interface OrderSeriesPoint {
  bucket: string;
  ts: number;
  spawn_cnt: number;
  deliver_cnt: number;
  expire_cnt: number;
  ditch_cnt: number;
}

interface OrderKpi {
  spawn_cnt: number;
  deliver_cnt: number;
  expire_cnt: number;
  ditch_cnt: number;
  deliver_rate: number | null;
  timed_deliver_rate: number | null;
  total_huayuan_from_orders: number;
  total_diamond_from_orders: number;
  computed_at: number;
}

interface OrderResponse {
  ok: boolean;
  query?: { game_key: string; from: string; to: string; window_minutes: number };
  kpi?: OrderKpi;
  by_tier?: OrderTierRow[];
  series?: OrderSeriesPoint[];
  code?: string;
  error?: string;
}

/**
 * 订单转化漏斗（花花专属）。
 *
 * 核心问题：
 *   - 客人到店后有多少最终被交付？哪些档位（tier）在丢？
 *   - 限时单的完成率是否健康？
 *   - 订单事件的时间分布是否随活跃度同步起伏？
 *
 * 数据源：/api/realtime/huahua-order
 */
export function OrderFunnelPanel() {
  const { gameKey, platform, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<OrderResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (nextGameKey: string, nextWindow: WindowValue) => {
      const seq = ++requestSeqRef.current;
      try {
        const queryStr = appendPlatformQuery(buildWindowQuery(nextWindow), platform);
        const res = await fetch(
          `/api/realtime/huahua-order?game=${encodeURIComponent(nextGameKey)}&${queryStr}`,
        );
        const json = (await res.json()) as OrderResponse;
        if (seq !== requestSeqRef.current) return;
        if (!json.ok) {
          message.error(`获取订单数据失败：${json.error || json.code}`);
        }
        setData(json);
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        message.error(`加载订单数据失败：${String(error)}`);
      }
    },
    [platform, setLastRefreshedAt],
  );

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, platform, windowSel, refreshToken, load]);

  const series = data?.series || [];
  const byTier = data?.by_tier || [];
  const kpi = data?.kpi;

  const funnelOption = useMemo(() => {
    const total = kpi?.spawn_cnt ?? 0;
    const deliver = kpi?.deliver_cnt ?? 0;
    const expire = kpi?.expire_cnt ?? 0;
    const ditch = kpi?.ditch_cnt ?? 0;
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c}' },
      series: [
        {
          type: 'funnel',
          left: '10%',
          right: '10%',
          top: 30,
          bottom: 30,
          minSize: '15%',
          maxSize: '95%',
          sort: 'descending',
          gap: 4,
          label: { show: true, position: 'inside', color: '#fff', fontWeight: 600 },
          data: [
            { name: '生成订单', value: total, itemStyle: { color: '#94a3b8' } },
            { name: '完成订单', value: deliver, itemStyle: { color: '#059669' } },
            { name: '超时订单', value: expire, itemStyle: { color: '#d97706' } },
            { name: '撕单订单', value: ditch, itemStyle: { color: '#e11d48' } },
          ].filter((d) => d.value > 0),
        },
      ],
    };
  }, [kpi]);

  const seriesOption = useMemo(() => {
    const xAxis = series.map((p) => bucketShort(p.bucket));
    const zoomStart = defaultZoomStart(series.length);
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['生成', '完成', '超时', '撕单'], ...CHART_LEGEND_TOP },
      grid: CHART_GRID_WITH_ZOOM,
      xAxis: { type: 'category', data: xAxis, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', name: '次数', minInterval: 1 },
      dataZoom: makeDataZoom(zoomStart, 100),
      series: [
        {
          name: '生成',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#94a3b8' },
          data: series.map((p) => p.spawn_cnt),
        },
        {
          name: '完成',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#059669' },
          data: series.map((p) => p.deliver_cnt),
        },
        {
          name: '超时',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#d97706' },
          data: series.map((p) => p.expire_cnt),
        },
        {
          name: '撕单',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#e11d48' },
          data: series.map((p) => p.ditch_cnt),
        },
      ],
    };
  }, [series]);

  const tierColumns = [
    { title: '订单档位', dataIndex: 'tier', key: 'tier' },
    {
      title: '生成',
      dataIndex: 'spawn_cnt',
      key: 'spawn_cnt',
      align: 'right' as const,
      render: (v: number) => formatInt(v),
    },
    {
      title: '完成',
      dataIndex: 'deliver_cnt',
      key: 'deliver_cnt',
      align: 'right' as const,
      render: (v: number) => formatInt(v),
    },
    {
      title: '超时',
      dataIndex: 'expire_cnt',
      key: 'expire_cnt',
      align: 'right' as const,
      render: (v: number) => formatInt(v),
    },
    {
      title: '撕单',
      dataIndex: 'ditch_cnt',
      key: 'ditch_cnt',
      align: 'right' as const,
      render: (v: number) => formatInt(v),
    },
    {
      title: '完成率',
      dataIndex: 'deliver_rate',
      key: 'deliver_rate',
      align: 'right' as const,
      render: (v: number | null) => formatPercent(v),
    },
  ];

  return (
    <Card
      title={
        <Tooltip title="数据源：order_spawn / order_deliver / order_expire / order_ditch">
          <span style={{ cursor: 'help' }}>订单转化漏斗</span>
        </Tooltip>
      }
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="生成订单" value={formatInt(kpi?.spawn_cnt)} suffix="单" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="完成订单" value={formatInt(kpi?.deliver_cnt)} suffix="单" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="= 完成 / 生成。生命周期内的客人订单转化基线">
                <Statistic title="完成率" value={formatPercent(kpi?.deliver_rate)} />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="限时钻石单（order_type=timed）的完成率，钻石单卡顿严重时会拖低这个数">
                <Statistic title="限时单完成率" value={formatPercent(kpi?.timed_deliver_rate)} />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="超时订单" value={formatInt(kpi?.expire_cnt)} suffix="单" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="撕单订单" value={formatInt(kpi?.ditch_cnt)} suffix="单" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="花愿产出" value={formatInt(kpi?.total_huayuan_from_orders)} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="钻石产出" value={formatInt(kpi?.total_diamond_from_orders)} />
            </Card>
          </Col>
        </Row>

        <Row gutter={[16, 16]}>
          <Col xs={24} lg={10}>
            <Card type="inner" title="订单生命周期漏斗">
              {(kpi?.spawn_cnt ?? 0) > 0 ? (
                <ReactECharts option={funnelOption} style={{ height: 280 }} />
              ) : (
                <Empty description="窗口内还没有订单事件" />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={14}>
            <Card type="inner" title="按订单档位分布">
              <Table
                size="small"
                dataSource={byTier}
                rowKey="tier"
                pagination={false}
                columns={tierColumns}
                locale={{ emptyText: '暂无 tier 维度数据' }}
              />
            </Card>
          </Col>
        </Row>

        <Card type="inner" title="订单事件趋势（5 分钟桶）">
          {series.length > 0 ? (
            <ReactECharts option={seriesOption} style={{ height: 280 }} />
          ) : (
            <Empty description="窗口内还没有订单事件" />
          )}
        </Card>
      </Space>
    </Card>
  );
}

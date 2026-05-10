import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Col, Empty, Row, Space, Statistic, Table, Tooltip, Typography, message } from 'antd';
import ReactECharts from 'echarts-for-react';

import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { buildWindowQuery, type WindowValue } from '../timeWindow';

import { bucketShort, defaultZoomStart, formatInt } from './utils';

const { Text } = Typography;

interface EconomyChannelRow {
  channel: string;
  amount: number;
  cnt: number;
}

interface EconomySeriesPoint {
  bucket: string;
  ts: number;
  huayuan_in: number;
  huayuan_out: number;
  diamond_in: number;
  diamond_out: number;
}

interface EconomyKpi {
  huayuan_in: number;
  huayuan_out: number;
  huayuan_net: number;
  diamond_in: number;
  diamond_out: number;
  diamond_net: number;
  stamina_buy_cnt: number;
  stamina_ad_cnt: number;
  active_economy_users: number;
  computed_at: number;
}

interface EconomyResponse {
  ok: boolean;
  query?: { game_key: string; from: string; to: string; window_minutes: number };
  kpi?: EconomyKpi;
  huayuan_in_channels?: EconomyChannelRow[];
  huayuan_out_channels?: EconomyChannelRow[];
  diamond_in_channels?: EconomyChannelRow[];
  diamond_out_channels?: EconomyChannelRow[];
  series?: EconomySeriesPoint[];
  code?: string;
  error?: string;
}

const CHANNEL_LABELS: Record<string, string> = {
  order_deliver: '客人订单交付',
  idle_reward_claim: '离线收益领取',
  checkin_sign: '签到',
  checkin_streak_bonus: '签到连续奖励',
  fountain_draw: '许愿喷泉',
  decoration_purchase: '家具/装饰购买',
  dressup_unlock: '换装解锁',
  stamina_buy: '钻石买体力',
};

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] || channel;
}

/**
 * 花花经济流转健康度。
 *
 * 关注点：
 *   - 花愿/钻石入账 vs 出账各渠道占比，看玩家产出口径是否健康
 *   - 净流时间序列：负净流持续 = 玩家在消耗存量（活跃征兆），正净流持续 = 经济膨胀
 *   - 体力购买/广告恢复次数：钻石→体力的"硬通货"出口监控
 *
 * 数据源：/api/realtime/huahua-economy
 */
export function EconomyFlowPanel() {
  const { gameKey, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<EconomyResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (nextGameKey: string, nextWindow: WindowValue) => {
      const seq = ++requestSeqRef.current;
      try {
        const queryStr = buildWindowQuery(nextWindow);
        const res = await fetch(
          `/api/realtime/huahua-economy?game=${encodeURIComponent(nextGameKey)}&${queryStr}`,
        );
        const json = (await res.json()) as EconomyResponse;
        if (seq !== requestSeqRef.current) return;
        if (!json.ok) {
          message.error(`获取经济流转数据失败：${json.error || json.code}`);
        }
        setData(json);
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        message.error(`加载经济流转数据失败：${String(error)}`);
      }
    },
    [setLastRefreshedAt],
  );

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, windowSel, refreshToken, load]);

  const series = data?.series || [];
  const kpi = data?.kpi;

  const flowOption = useMemo(() => {
    const xAxis = series.map((p) => bucketShort(p.bucket));
    const zoomStart = defaultZoomStart(series.length);
    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['花愿入账', '花愿出账', '钻石入账', '钻石出账'],
        textStyle: { color: '#374151', fontSize: 13, fontWeight: 500 },
      },
      grid: { left: 50, right: 50, top: 50, bottom: 60 },
      xAxis: { type: 'category', data: xAxis, axisLabel: { hideOverlap: true } },
      yAxis: [
        { type: 'value', name: '花愿', minInterval: 1 },
        { type: 'value', name: '钻石', minInterval: 1, position: 'right' },
      ],
      dataZoom: [
        { type: 'inside', start: zoomStart, end: 100 },
        { type: 'slider', height: 18, bottom: 10, start: zoomStart, end: 100 },
      ],
      series: [
        {
          name: '花愿入账',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#10b981' },
          areaStyle: { color: 'rgba(16,185,129,0.1)' },
          data: series.map((p) => p.huayuan_in),
        },
        {
          name: '花愿出账',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#ef4444' },
          areaStyle: { color: 'rgba(239,68,68,0.08)' },
          data: series.map((p) => p.huayuan_out),
        },
        {
          name: '钻石入账',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: '#3b82f6' },
          data: series.map((p) => p.diamond_in),
        },
        {
          name: '钻石出账',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: '#a855f7' },
          data: series.map((p) => p.diamond_out),
        },
      ],
    };
  }, [series]);

  const channelColumns = (currency: '花愿' | '钻石') => [
    {
      title: '渠道',
      dataIndex: 'channel',
      key: 'channel',
      render: (v: string) => <span title={v}>{channelLabel(v)}</span>,
    },
    {
      title: `${currency}金额`,
      dataIndex: 'amount',
      key: 'amount',
      align: 'right' as const,
      render: (v: number) => formatInt(v),
    },
    {
      title: '事件数',
      dataIndex: 'cnt',
      key: 'cnt',
      align: 'right' as const,
      render: (v: number) => formatInt(v),
    },
  ];

  return (
    <Card
      title="经济流转健康度"
      extra={<Text type="secondary">数据源：order_deliver / decoration_purchase / idle_reward_claim ...</Text>}
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="窗口内有任意经济相关事件的去重用户数">
                <Statistic
                  title="活跃经济用户"
                  value={formatInt(kpi?.active_economy_users)}
                  suffix="人"
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="入 - 出。负数 = 玩家在消耗存量；持续正数 = 经济膨胀风险">
                <Statistic
                  title="花愿净流"
                  value={formatInt(kpi?.huayuan_net)}
                  valueStyle={{
                    color:
                      (kpi?.huayuan_net ?? 0) > 0
                        ? '#10b981'
                        : (kpi?.huayuan_net ?? 0) < 0
                          ? '#ef4444'
                          : undefined,
                  }}
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="花愿入账" value={formatInt(kpi?.huayuan_in)} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="花愿出账" value={formatInt(kpi?.huayuan_out)} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="钻石净流"
                value={formatInt(kpi?.diamond_net)}
                valueStyle={{
                  color:
                    (kpi?.diamond_net ?? 0) > 0
                      ? '#10b981'
                      : (kpi?.diamond_net ?? 0) < 0
                        ? '#ef4444'
                        : undefined,
                }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="钻石入账" value={formatInt(kpi?.diamond_in)} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="钻石→体力的次数（玩家用硬通货续命）">
                <Statistic
                  title="体力购买"
                  value={formatInt(kpi?.stamina_buy_cnt)}
                  suffix="次"
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="体力广告恢复"
                value={formatInt(kpi?.stamina_ad_cnt)}
                suffix="次"
              />
            </Card>
          </Col>
        </Row>

        <Card type="inner" title="经济流转时间序列（5 分钟桶）">
          {series.length > 0 ? (
            <ReactECharts option={flowOption} style={{ height: 320 }} />
          ) : (
            <Empty description="窗口内还没有经济事件" />
          )}
        </Card>

        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card type="inner" title="花愿入账渠道">
              <Table
                size="small"
                dataSource={data?.huayuan_in_channels || []}
                rowKey="channel"
                pagination={false}
                columns={channelColumns('花愿')}
                locale={{ emptyText: '暂无数据' }}
              />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card type="inner" title="花愿出账渠道">
              <Table
                size="small"
                dataSource={data?.huayuan_out_channels || []}
                rowKey="channel"
                pagination={false}
                columns={channelColumns('花愿')}
                locale={{ emptyText: '暂无数据' }}
              />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card type="inner" title="钻石入账渠道">
              <Table
                size="small"
                dataSource={data?.diamond_in_channels || []}
                rowKey={(r) => `${r.channel}-${r.amount}`}
                pagination={false}
                columns={channelColumns('钻石')}
                locale={{ emptyText: '暂无数据' }}
              />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card type="inner" title="钻石出账渠道">
              <Table
                size="small"
                dataSource={data?.diamond_out_channels || []}
                rowKey="channel"
                pagination={false}
                columns={channelColumns('钻石')}
                locale={{ emptyText: '暂无数据' }}
              />
            </Card>
          </Col>
        </Row>
      </Space>
    </Card>
  );
}

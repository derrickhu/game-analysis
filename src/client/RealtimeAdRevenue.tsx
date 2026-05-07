import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Card, Col, Descriptions, Empty, Row, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';

import { type WindowValue, buildWindowQuery } from './timeWindow';

// 顶部 App.tsx 全局选择器统一管控：gameKey、windowSel（时间窗口）、refreshToken（手动刷新计数）
// 都从 props 传入，子组件不再持有任何独立筛选器，避免「上面选 today、卡片右上角又是 1h」的混淆

const { Title } = Typography;

interface AdSeriesItem {
  minute: string;
  ad_request_cnt: number;
  ad_show_cnt: number;
  ad_click_cnt: number;
  ad_complete_cnt: number;
  ad_error_cnt: number;
  ad_revenue_estimated_cny: number;
}

interface AdSummary {
  game_key: string;
  from: string;
  to: string;
  total_show: number;
  total_click: number;
  total_complete: number;
  total_request: number;
  total_error: number;
  total_revenue_estimated_cny: number;
  ctr: number;
  completion_rate: number;
}

interface AdBreakdown {
  ad_type: string;
  scene: string;
  ad_show_cnt: number;
  ad_click_cnt: number;
  ad_complete_cnt: number;
  ad_revenue_estimated_cny: number;
}

interface AdRevenueResponse {
  ok: true;
  estimated: true;
  notice: string;
  query: { game_key: string; from: string; to: string; window_minutes: number };
  summary: AdSummary;
  series: AdSeriesItem[];
  breakdown_by_scene: AdBreakdown[];
}

interface HealthResponse {
  ok: true;
  games: Array<{ game_key: string; display_name: string; cloud_env: string }>;
  stats: {
    totalEvents: number;
    last24hEvents: number;
    oldestEventTs: number | null;
    newestEventTs: number | null;
  };
  recent_runs: Array<{
    id: number;
    game_key: string;
    started_at: number;
    finished_at: number;
    status: string;
    fetched: number;
    cursor_before: number;
    cursor_after: number;
    error_message: string;
  }>;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '0';
}

function formatTs(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN');
}

function formatMinuteLabel(minute: string): string {
  // YYYY-MM-DDTHH:mm -> MM-DD HH:mm（按本地时区显示）
  if (!minute) return '';
  const utcDate = new Date(`${minute}:00.000Z`);
  if (isNaN(utcDate.getTime())) return minute;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(utcDate.getMonth() + 1)}-${pad(utcDate.getDate())} ${pad(utcDate.getHours())}:${pad(utcDate.getMinutes())}`;
}

interface RealtimeAdRevenueProps {
  /** 必填：当前选中的游戏（由 App 顶部全局选择器决定），本组件随之刷新 */
  fixedGameKey: string;
  /** 必填：全局时间窗口（由 App 顶部 Select 决定） */
  windowSel: WindowValue;
  /** 必填：每点击一次顶部刷新就 +1，子组件 useEffect 依赖它来重新拉数据 */
  refreshToken: number;
}

export function RealtimeAdRevenue(props: RealtimeAdRevenueProps): ReactElement {
  const { fixedGameKey: gameKey, windowSel, refreshToken } = props;
  const [data, setData] = useState<AdRevenueResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      // 健康度仅与 gameKey 有关（跟时间窗口无关），但还是跟随全局刷新一起重拉
      const url = `/api/realtime/health?game=${encodeURIComponent(gameKey)}`;
      const res = await fetch(url);
      const json = (await res.json()) as HealthResponse | { ok: false };
      if ('ok' in json && json.ok) {
        setHealth(json);
      }
    } catch (err) {
      console.warn('[realtime-ad] load health failed', err);
    }
  }, [gameKey]);

  const loadData = useCallback(async () => {
    try {
      // 'today' 每次实时算今日 00:00，跨过半夜会自动滑到新的一天
      const queryStr = buildWindowQuery(windowSel);
      const url = `/api/realtime/ad-revenue?game=${encodeURIComponent(gameKey)}&${queryStr}`;
      const res = await fetch(url);
      const json = (await res.json()) as AdRevenueResponse | { ok: false; error?: string };
      if ('ok' in json && json.ok) {
        setData(json);
      }
    } catch (err) {
      console.warn('[realtime-ad] load ad data failed', err);
    }
  }, [gameKey, windowSel]);

  useEffect(() => {
    void loadHealth();
    void loadData();
    // refreshToken 变化即触发重新拉取（来自顶部刷新按钮 / 自动 5 分钟 timer / 立即拉取后强制刷新）
  }, [loadHealth, loadData, refreshToken]);

  const chartOption = useMemo(() => {
    const series = data?.series || [];
    const xLabels = series.map((s) => formatMinuteLabel(s.minute));
    // 5 分钟粒度下，1 小时只有 12 桶、6 小时 72 桶，默认全展示就好
    // 仅当 24 小时这种宽窗口（288 桶）才默认缩到最近 60 桶以避免过密
    const zoomStart = series.length > 60 ? Math.max(0, 100 - (60 / series.length) * 100) : 0;
    return {
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? '')),
      },
      legend: {
        data: ['曝光数', '估算收益(元)'],
        top: 6,
        itemGap: 28,
        itemWidth: 18,
        itemHeight: 12,
        textStyle: { fontSize: 13, color: '#262626', fontWeight: 500 },
      },
      grid: { left: 64, right: 64, top: 56, bottom: 64 },
      dataZoom: [
        { type: 'inside' as const, start: zoomStart, end: 100 },
        { type: 'slider' as const, height: 18, bottom: 16, start: zoomStart, end: 100 },
      ],
      xAxis: {
        type: 'category' as const,
        data: xLabels,
        boundaryGap: true,
        axisLabel: { fontSize: 11, hideOverlap: true, color: '#595959' },
        axisTick: { alignWithLabel: true },
      },
      yAxis: [
        {
          type: 'value' as const,
          name: '曝光数',
          nameTextStyle: { fontSize: 12, color: '#595959', padding: [0, 24, 0, 0] },
          axisLabel: { fontSize: 11, color: '#595959' },
          minInterval: 1,
          splitLine: { lineStyle: { type: 'dashed' as const, opacity: 0.5 } },
        },
        {
          type: 'value' as const,
          name: '估算收益(元)',
          position: 'right' as const,
          nameTextStyle: { fontSize: 12, color: '#FF8A3D', padding: [0, 0, 0, 24] },
          axisLabel: { fontSize: 11, color: '#FF8A3D', formatter: (v: number) => v.toFixed(2) },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '曝光数',
          type: 'bar' as const,
          // 给柱子设最大宽度 + 高于 0 的最小高度，避免曝光数为 1 时柱子像头发丝细
          barMaxWidth: 22,
          barMinHeight: 2,
          itemStyle: { color: '#5B8FF9', borderRadius: [3, 3, 0, 0] },
          emphasis: { itemStyle: { color: '#3D7BFA' } },
          data: series.map((s) => s.ad_show_cnt),
          yAxisIndex: 0,
        },
        {
          name: '估算收益(元)',
          type: 'line' as const,
          smooth: true,
          symbol: 'circle' as const,
          symbolSize: 7,
          lineStyle: { width: 2.5, color: '#FF8A3D' },
          itemStyle: { color: '#FF8A3D' },
          areaStyle: {
            color: {
              type: 'linear' as const,
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(255, 138, 61, 0.28)' },
                { offset: 1, color: 'rgba(255, 138, 61, 0)' },
              ],
            },
          },
          data: series.map((s) => s.ad_revenue_estimated_cny),
          yAxisIndex: 1,
        },
      ],
    };
  }, [data]);

  const breakdownColumns = [
    { title: '广告类型', dataIndex: 'ad_type', key: 'ad_type' },
    { title: '场景', dataIndex: 'scene', key: 'scene' },
    {
      title: '曝光',
      dataIndex: 'ad_show_cnt',
      key: 'ad_show_cnt',
      render: (v: number) => formatNumber(v),
    },
    {
      title: '点击',
      dataIndex: 'ad_click_cnt',
      key: 'ad_click_cnt',
      render: (v: number) => formatNumber(v),
    },
    {
      title: '完播',
      dataIndex: 'ad_complete_cnt',
      key: 'ad_complete_cnt',
      render: (v: number) => formatNumber(v),
    },
    {
      title: (
        <span>
          估算收益(元)
          <Tag color="orange" style={{ marginLeft: 6 }}>估算</Tag>
        </span>
      ),
      dataIndex: 'ad_revenue_estimated_cny',
      key: 'ad_revenue_estimated_cny',
      render: (v: number) => formatNumber(v),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        message="广告金额均为估算值"
        description={data?.notice || '所有金额来自客户端 ad_show 计数 × 配置 eCPM 的估算，并非真实结算收入。'}
      />

      <Card
        size="small"
        title={`实时广告收益（估算） · ${gameKey}`}
      >
        <Row gutter={16}>
          <Col span={4}>
            <Statistic title="曝光数" value={data?.summary.total_show ?? 0} />
          </Col>
          <Col span={4}>
            <Statistic title="点击数" value={data?.summary.total_click ?? 0} />
          </Col>
          <Col span={4}>
            <Statistic title="完播数" value={data?.summary.total_complete ?? 0} />
          </Col>
          <Col span={4}>
            <Tooltip title="点击数 / 曝光数">
              <Statistic title="CTR(%)" value={data?.summary.ctr ?? 0} precision={2} />
            </Tooltip>
          </Col>
          <Col span={4}>
            <Tooltip title="完播数 / 曝光数">
              <Statistic title="完播率(%)" value={data?.summary.completion_rate ?? 0} precision={2} />
            </Tooltip>
          </Col>
          <Col span={4}>
            <Statistic
              title={(<span>估算收益(元) <Tag color="orange">估算</Tag></span>) as unknown as string}
              value={data?.summary.total_revenue_estimated_cny ?? 0}
              precision={2}
            />
          </Col>
        </Row>
      </Card>

      <Card size="small" title="分钟级趋势">
        {data && data.series.length > 0 ? (
          <ReactECharts option={chartOption} style={{ height: 380 }} notMerge lazyUpdate />
        ) : (
          <Empty description="暂无数据。后端按 5 分钟粒度聚合、cron 每 5 分钟拉取一次，刚上报的事件最长延迟 5 分钟才会出现" />
        )}
      </Card>

      <Card size="small" title="按场景拆分">
        {data && data.breakdown_by_scene.length > 0 ? (
          <Table
            size="small"
            rowKey={(row) => `${row.ad_type}|${row.scene}`}
            columns={breakdownColumns}
            dataSource={data.breakdown_by_scene}
            pagination={false}
          />
        ) : (
          <Empty description="暂无场景维度数据" />
        )}
      </Card>

      <Card size="small" title="上报系统健康度">
        {health ? (
          <Row gutter={16}>
            <Col span={12}>
              <Descriptions column={1} size="small">
                <Descriptions.Item label="本地事件总数">{formatNumber(health.stats.totalEvents)}</Descriptions.Item>
                <Descriptions.Item label="近 24h 新增">{formatNumber(health.stats.last24hEvents)}</Descriptions.Item>
                <Descriptions.Item label="最早事件">{formatTs(health.stats.oldestEventTs)}</Descriptions.Item>
                <Descriptions.Item label="最新事件">{formatTs(health.stats.newestEventTs)}</Descriptions.Item>
              </Descriptions>
            </Col>
            <Col span={12}>
              <Title level={5}>最近 cron 拉取</Title>
              <Table
                size="small"
                rowKey="id"
                columns={[
                  { title: '游戏', dataIndex: 'game_key', key: 'game_key', width: 80 },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    key: 'status',
                    width: 70,
                    render: (v: string) => <Tag color={v === 'success' ? 'green' : 'red'}>{v}</Tag>,
                  },
                  {
                    title: '拉取条数',
                    dataIndex: 'fetched',
                    key: 'fetched',
                    width: 80,
                    render: (v: number) => formatNumber(v),
                  },
                  {
                    title: '完成时间',
                    dataIndex: 'finished_at',
                    key: 'finished_at',
                    render: (v: number) => formatTs(v),
                  },
                ]}
                dataSource={health.recent_runs}
                pagination={{ pageSize: 5 }}
              />
            </Col>
          </Row>
        ) : (
          <Empty description="健康度未加载" />
        )}
      </Card>
    </Space>
  );
}

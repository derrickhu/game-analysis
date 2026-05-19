import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Col, Empty, Row, Space, Statistic, Typography, message } from 'antd';
import ReactECharts from 'echarts-for-react';

import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { buildWindowQuery, type WindowValue } from '../timeWindow';

const { Text } = Typography;

interface FruitSliceResponse {
  ok: boolean;
  kpi?: {
    total_starts: number;
    total_ends: number;
    start_users: number;
    avg_score: number;
    avg_duration_ms: number;
    avg_match_count: number;
    revive_count: number;
    checkpoint_start_count: number;
    tool_use_count: number;
    milestone_count: number;
  };
  series?: Array<{ bucket: string; start_cnt: number; end_cnt: number; revive_cnt: number; tool_cnt: number }>;
  fail_reasons?: Array<{ reason: string; count: number }>;
  start_sources?: Array<{ source: string; count: number }>;
  tool_usage?: Array<{ tool_kind: string; count: number }>;
  score_buckets?: Array<{ bucket: string; count: number }>;
  code?: string;
  error?: string;
}

function formatDuration(ms: number): string {
  if (!ms) return '-';
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

function bucketShort(bucket: string): string {
  const date = new Date(`${bucket}:00.000Z`);
  if (Number.isNaN(date.getTime())) return bucket;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function HotpotFruitSlicePanel() {
  const { gameKey, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<FruitSliceResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async (nextGameKey: string, nextWindow: WindowValue) => {
    const seq = ++requestSeqRef.current;
    try {
      const res = await fetch(`/api/realtime/hotpot-fruit-slice?game=${encodeURIComponent(nextGameKey)}&${buildWindowQuery(nextWindow)}`);
      const json = (await res.json()) as FruitSliceResponse;
      if (seq !== requestSeqRef.current) return;
      if (!json.ok) message.error(`获取果切挑战数据失败: ${json.error || json.code}`);
      setData(json);
      setLastRefreshedAt(Date.now());
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      message.error(`加载果切挑战数据失败: ${String(error)}`);
    }
  }, [setLastRefreshedAt]);

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, windowSel, refreshToken, load]);

  const trendOption = useMemo(() => {
    const series = data?.series || [];
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['开始', '结束', '复活', '道具'] },
      grid: { left: 50, right: 30, top: 50, bottom: 40 },
      xAxis: { type: 'category', data: series.map((p) => bucketShort(p.bucket)), axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        { name: '开始', type: 'line', smooth: true, data: series.map((p) => p.start_cnt) },
        { name: '结束', type: 'line', smooth: true, data: series.map((p) => p.end_cnt) },
        { name: '复活', type: 'line', smooth: true, data: series.map((p) => p.revive_cnt) },
        { name: '道具', type: 'line', smooth: true, data: series.map((p) => p.tool_cnt) },
      ],
    };
  }, [data?.series]);

  const scoreOption = useMemo(() => {
    const rows = data?.score_buckets || [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 20, top: 20, bottom: 30 },
      xAxis: { type: 'category', data: rows.map((r) => r.bucket) },
      yAxis: { type: 'value', minInterval: 1 },
      series: [{ type: 'bar', data: rows.map((r) => r.count), itemStyle: { color: '#f97316' } }],
    };
  }, [data?.score_buckets]);

  const kpi = data?.kpi;
  return (
    <Card title="果切挑战分析" extra={<Text type="secondary">fruit_slice_start / end / tool_use / revive</Text>}>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}><Card size="small"><Statistic title="开始局数" value={kpi?.total_starts ?? 0} suffix="局" /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="结束局数" value={kpi?.total_ends ?? 0} suffix="局" /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="参与用户" value={kpi?.start_users ?? 0} suffix="人" /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="平均分" value={kpi?.avg_score ?? 0} /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="平均时长" value={formatDuration(kpi?.avg_duration_ms ?? 0)} /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="平均消除" value={kpi?.avg_match_count ?? 0} suffix="次" /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="复活次数" value={kpi?.revive_count ?? 0} suffix="次" /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="档位开始" value={kpi?.checkpoint_start_count ?? 0} suffix="次" /></Card></Col>
        </Row>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={14}>
            <Card type="inner" title="事件趋势（5 分钟桶）">
              {(data?.series?.length || 0) > 0 ? <ReactECharts option={trendOption} style={{ height: 280 }} /> : <Empty description="暂无果切事件" />}
            </Card>
          </Col>
          <Col xs={24} lg={10}>
            <Card type="inner" title="结束分数分布">
              {(data?.score_buckets?.some((r) => r.count > 0)) ? <ReactECharts option={scoreOption} style={{ height: 280 }} /> : <Empty description="暂无结束分数" />}
            </Card>
          </Col>
        </Row>
      </Space>
    </Card>
  );
}

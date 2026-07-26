import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Col, Empty, Row, Space, Statistic, Tooltip, Typography, message } from 'antd';
import ReactECharts from 'echarts-for-react';

import { appendPlatformQuery } from '../../shared/platforms';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { buildWindowQuery, type WindowValue } from '../timeWindow';

const { Text } = Typography;

interface DailyLimitedResponse {
  ok: boolean;
  kpi?: {
    total_starts: number;
    total_ends: number;
    start_users: number;
    success_count: number;
    fail_count: number;
    success_rate: number | null;
    avg_duration_ms: number;
    avg_card_clicks: number;
    avg_collected_count: number;
    buffer_unlock_count: number;
    buffer_unlock_users: number;
    ended_with_unlock_count: number;
    share_count: number;
    tool_use_count: number;
  };
  series?: Array<{ bucket: string; start_cnt: number; success_cnt: number; fail_cnt: number; tool_cnt: number }>;
  level_distribution?: Array<{ level_id: number; drink_name: string; starts: number; success: number; fails: number; success_rate: number | null }>;
  end_reasons?: Array<{ reason: string; count: number }>;
  tool_usage?: Array<{ tool_kind: string; count: number }>;
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

export function HotpotDailyLimitedPanel() {
  const { gameKey, platform, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<DailyLimitedResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async (nextGameKey: string, nextWindow: WindowValue) => {
    const seq = ++requestSeqRef.current;
    try {
      const queryStr = appendPlatformQuery(buildWindowQuery(nextWindow), platform);
      const res = await fetch(`/api/realtime/hotpot-daily-limited?game=${encodeURIComponent(nextGameKey)}&${queryStr}`);
      const json = (await res.json()) as DailyLimitedResponse;
      if (seq !== requestSeqRef.current) return;
      if (!json.ok) message.error(`获取每日限定数据失败: ${json.error || json.code}`);
      setData(json);
      setLastRefreshedAt(Date.now());
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      message.error(`加载每日限定数据失败: ${String(error)}`);
    }
  }, [platform, setLastRefreshedAt]);

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, platform, windowSel, refreshToken, load]);

  const trendOption = useMemo(() => {
    const series = data?.series || [];
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['开始', '完成', '失败', '道具'] },
      grid: { left: 50, right: 30, top: 50, bottom: 40 },
      xAxis: { type: 'category', data: series.map((p) => bucketShort(p.bucket)), axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        { name: '开始', type: 'line', smooth: true, data: series.map((p) => p.start_cnt) },
        { name: '完成', type: 'line', smooth: true, data: series.map((p) => p.success_cnt) },
        { name: '失败', type: 'line', smooth: true, data: series.map((p) => p.fail_cnt) },
        { name: '道具', type: 'line', smooth: true, data: series.map((p) => p.tool_cnt) },
      ],
    };
  }, [data?.series]);

  const levelOption = useMemo(() => {
    const rows = data?.level_distribution || [];
    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['开始', '完成', '失败'],
        top: 0,
        right: 8,
        itemWidth: 14,
        itemHeight: 10,
        textStyle: { color: '#374151', fontSize: 12, fontWeight: 500 },
      },
      grid: { left: 50, right: 20, top: 48, bottom: 64 },
      xAxis: {
        type: 'category',
        data: rows.map((r) => `${r.level_id}日\n${r.drink_name}`),
        axisLabel: {
          interval: 0,
          hideOverlap: false,
          color: '#374151',
          fontSize: 12,
          lineHeight: 16,
        },
      },
      yAxis: { type: 'value', minInterval: 1 },
      series: [
        { name: '开始', type: 'bar', data: rows.map((r) => r.starts) },
        { name: '完成', type: 'bar', data: rows.map((r) => r.success) },
        { name: '失败', type: 'bar', data: rows.map((r) => r.fails) },
      ],
    };
  }, [data?.level_distribution]);

  const kpi = data?.kpi;
  return (
    <Card title="每日限定分析" extra={<Text type="secondary">daily_limited_start / end / tool_use / buffer_unlock</Text>}>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}><Card size="small"><Statistic title="开始局数" value={kpi?.total_starts ?? 0} suffix="局" /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="完成局数" value={kpi?.success_count ?? 0} suffix="局" /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="失败局数" value={kpi?.fail_count ?? 0} suffix="局" /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="完成率" value={kpi?.success_rate !== null && kpi?.success_rate !== undefined ? (kpi.success_rate * 100).toFixed(1) : '-'} suffix={kpi?.success_rate ? '%' : ''} /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="参与用户" value={kpi?.start_users ?? 0} suffix="人" /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="平均时长" value={formatDuration(kpi?.avg_duration_ms ?? 0)} /></Card></Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="平均点击" value={kpi?.avg_card_clicks ?? 0} suffix="次" /></Card></Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="点击额外暂存格解锁广告的次数，包含最终失败或返回首页的局。">
                <Statistic title="额外格解锁" value={kpi?.buffer_unlock_count ?? 0} suffix="次" />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="点击过额外暂存格解锁的去重用户，不要求本局完成，所以可能大于完成局数。">
                <Statistic title="额外格解锁用户" value={kpi?.buffer_unlock_users ?? 0} suffix="人" />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="结束事件中 extra_buffer_unlocked=true 的局数，包含完成、失败和返回首页。">
                <Statistic title="带解锁结束" value={kpi?.ended_with_unlock_count ?? 0} suffix="局" />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}><Card size="small"><Statistic title="配方分享" value={kpi?.share_count ?? 0} suffix="次" /></Card></Col>
        </Row>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={14}>
            <Card type="inner" title="挑战趋势（5 分钟桶）">
              {(data?.series?.length || 0) > 0 ? <ReactECharts option={trendOption} style={{ height: 280 }} /> : <Empty description="暂无每日限定事件" />}
            </Card>
          </Col>
          <Col xs={24} lg={10}>
            <Card type="inner" title="每日主题分布">
              {(data?.level_distribution?.length || 0) > 0 ? <ReactECharts option={levelOption} style={{ height: 280 }} /> : <Empty description="暂无每日主题数据" />}
            </Card>
          </Col>
        </Row>
      </Space>
    </Card>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Card, Col, Empty, Row, Space, Statistic, Table, Tooltip, Typography, message } from 'antd';

import { appendPlatformQuery } from '../../shared/platforms';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import ReactECharts from '../components/AnalyticsChart';
import { buildWindowQuery, type WindowValue } from '../timeWindow';
import { CHART_GRID_WITH_ZOOM, CHART_LEGEND_TOP, makeDataZoom } from './utils';

const { Text } = Typography;

interface PetTowerGameplayResponse {
  ok: boolean;
  kpi?: {
    dau: number;
    play_users: number;
    session_cnt: number;
    play_minutes: number;
    avg_session_ms: number;
    median_session_ms: number;
    minutes_per_user: number;
    duration_source: string;
    ad_show_cnt: number;
    ad_complete_cnt: number;
    ad_revenue_estimated_cny: number;
    arpdau_estimated_cny: number;
    tower_start_cnt: number;
    tower_clear_cnt: number;
    tower_clear_rate: number | null;
    tower_reset_cnt: number;
    max_floor: number;
  };
  mismatch?: {
    tower_avg_clear_ms: number;
    mainline_avg_clear_ms: number;
    duration_ratio: number | null;
    late_band_label: string;
    late_band_avg_coins: number;
    late_band_clear_rate: number | null;
    shop_coin_pack_marks: number;
    tower_minutes_for_coin_pack: number | null;
    wall_floors: number[];
  };
  session_buckets?: Array<{ range_label: string; count: number }>;
  daily?: Array<{
    date_key: string;
    dau: number;
    play_minutes: number;
    minutes_per_user: number;
    ad_show_cnt: number;
    ad_revenue_estimated_cny: number;
    tower_starts: number;
    tower_clears: number;
  }>;
  floor_bands?: Array<{
    band_label: string;
    starts: number;
    clears: number;
    clear_rate: number | null;
    avg_coins: number;
    coins_sum: number;
    difficulty_mid: number;
  }>;
  wall_floors?: Array<{
    floor: number;
    starts: number;
    clears: number;
    clear_rate: number | null;
    avg_coins: number;
    difficulty: number;
  }>;
  battle_modes?: Array<{
    mode: string;
    clears: number;
    avg_duration_ms: number;
    avg_turns: number;
  }>;
  ad_scenes?: Array<{
    scene: string;
    shows: number;
    completes: number;
    complete_rate: number | null;
    revenue_estimated_cny: number;
  }>;
  exchanges?: Array<{ option_id: string; count: number; cost_sum: number }>;
  code?: string;
  error?: string;
}

const MODE_LABELS: Record<string, string> = {
  mainline: '主线',
  tower: '通天塔',
  realm: '秘境',
  other: '其它',
};

const SCENE_LABELS: Record<string, string> = {
  victory_double: '结算翻倍',
  victory_home: '结算回城',
  quest_double: '日常翻倍',
  battle_revive: '战斗复活',
  realm_extra_run: '秘境加次',
  stamina_refill: '体力回复',
  free_gacha_pull: '免费召唤',
  checkin_double: '签到翻倍',
  tower_reset: '通天塔重置',
};

const EXCHANGE_LABELS: Record<string, string> = {
  tex_coins: '印记兑灵宠币',
  tex_lingyu: '印记兑灵玉',
  tex_universal: '印记兑通用碎片',
};

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (!ms) return '-';
  const sec = Math.round(ms / 1000);
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export function PetTowerGameplayPanel() {
  const { gameKey, platform, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<PetTowerGameplayResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async (nextGameKey: string, nextWindow: WindowValue) => {
    const seq = ++requestSeqRef.current;
    try {
      const queryStr = appendPlatformQuery(buildWindowQuery(nextWindow), platform);
      const res = await fetch(`/api/realtime/pet-tower-gameplay?game=${encodeURIComponent(nextGameKey)}&${queryStr}`);
      const json = (await res.json()) as PetTowerGameplayResponse;
      if (seq !== requestSeqRef.current) return;
      if (!json.ok) message.error(`获取塔2玩法数据失败: ${json.error || json.code}`);
      setData(json);
      setLastRefreshedAt(Date.now());
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      message.error(`加载塔2玩法数据失败: ${String(error)}`);
    }
  }, [platform, setLastRefreshedAt]);

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, platform, windowSel, refreshToken, load]);

  const kpi = data?.kpi;
  const mismatch = data?.mismatch;
  const daily = data?.daily || [];

  const dailyOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    legend: { data: ['人均时长(分)', '广告曝光', '估算收益(元)', '爬塔开始'], ...CHART_LEGEND_TOP },
    grid: { ...CHART_GRID_WITH_ZOOM, right: 56 },
    xAxis: { type: 'category', data: daily.map((d) => d.date_key.slice(5)), axisLabel: { hideOverlap: true } },
    yAxis: [
      { type: 'value', name: '分钟 / 次', minInterval: 1 },
      { type: 'value', name: '元', min: 0 },
    ],
    dataZoom: makeDataZoom(),
    series: [
      {
        name: '人均时长(分)',
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#2563eb', borderRadius: [4, 4, 0, 0] },
        data: daily.map((d) => d.minutes_per_user),
      },
      {
        name: '广告曝光',
        type: 'line',
        smooth: true,
        itemStyle: { color: '#d97706' },
        data: daily.map((d) => d.ad_show_cnt),
      },
      {
        name: '估算收益(元)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        itemStyle: { color: '#059669' },
        data: daily.map((d) => d.ad_revenue_estimated_cny),
      },
      {
        name: '爬塔开始',
        type: 'line',
        smooth: true,
        itemStyle: { color: '#7c3aed' },
        data: daily.map((d) => d.tower_starts),
      },
    ],
  }), [daily]);

  const sessionOption = useMemo(() => {
    const buckets = data?.session_buckets || [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 48, right: 24, top: 24, bottom: 40 },
      xAxis: { type: 'category', data: buckets.map((b) => b.range_label) },
      yAxis: { type: 'value', name: '会话数', minInterval: 1 },
      series: [{
        name: '会话数',
        type: 'bar',
        barMaxWidth: 28,
        itemStyle: { color: '#2563eb', borderRadius: [4, 4, 0, 0] },
        data: buckets.map((b) => b.count),
      }],
    };
  }, [data?.session_buckets]);

  const bandOption = useMemo(() => {
    const bands = data?.floor_bands || [];
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['开始', '通关', '通关率', '层中难度'], ...CHART_LEGEND_TOP },
      grid: { ...CHART_GRID_WITH_ZOOM, right: 56 },
      xAxis: { type: 'category', data: bands.map((b) => b.band_label) },
      yAxis: [
        { type: 'value', name: '次数', minInterval: 1 },
        { type: 'value', name: '比率 / 系数', min: 0 },
      ],
      dataZoom: makeDataZoom(),
      series: [
        {
          name: '开始',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#94a3b8', borderRadius: [4, 4, 0, 0] },
          data: bands.map((b) => b.starts),
        },
        {
          name: '通关',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#059669', borderRadius: [4, 4, 0, 0] },
          data: bands.map((b) => b.clears),
        },
        {
          name: '通关率',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          itemStyle: { color: '#2563eb' },
          data: bands.map((b) => (b.clear_rate === null ? null : +(b.clear_rate * 100).toFixed(1))),
        },
        {
          name: '层中难度',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          itemStyle: { color: '#e11d48' },
          data: bands.map((b) => b.difficulty_mid),
        },
      ],
    };
  }, [data?.floor_bands]);

  return (
    <Card title="灵宠消消塔2 · 时长 / 经济 / 通天塔">
      {kpi ? (
        <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
          {mismatch && (mismatch.duration_ratio || 0) >= 2 && (
            <Alert
              type="warning"
              showIcon
              message="爬塔耗时和印记对不上"
              description={
                `塔场均 ${formatDuration(mismatch.tower_avg_clear_ms)}，主线 ${formatDuration(mismatch.mainline_avg_clear_ms)}`
                + `${mismatch.duration_ratio ? `，约 ${mismatch.duration_ratio} 倍。` : '。'}`
                + (mismatch.late_band_label
                  ? ` 主要活动在 ${mismatch.late_band_label}；卡墙后场均印记 ${mismatch.late_band_avg_coins}，兑一档灵宠币要 ${mismatch.shop_coin_pack_marks} 印记`
                    + (mismatch.tower_minutes_for_coin_pack != null
                      ? `，按这个速度大约要打 ${mismatch.tower_minutes_for_coin_pack} 分钟塔。`
                      : '。')
                  : '')
                + (mismatch.wall_floors.length ? ` 卡墙层：${mismatch.wall_floors.map((f) => `F${f}`).join('、')}。` : '')
              }
            />
          )}

          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}><Card size="small"><Statistic title="窗口 DAU" value={kpi.dau} suffix="人" /></Card></Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Tooltip title="session_end 没有 duration_ms，按时长用相邻事件间隔 ≤5 分钟拼会话">
                  <Statistic title="重构后总时长" value={kpi.play_minutes} suffix="分钟" />
                </Tooltip>
              </Card>
            </Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="人均时长" value={kpi.minutes_per_user} suffix="分钟" /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="会话中位" value={formatDuration(kpi.median_session_ms)} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="广告曝光" value={kpi.ad_show_cnt} suffix="次" /></Card></Col>
            <Col xs={12} md={6}>
              <Card size="small">
                <Tooltip title="按 petTower.reward eCPM=24 估算；抖音流量主尚未接入，不是结算款">
                  <Statistic title="估算广告收益" value={kpi.ad_revenue_estimated_cny} suffix="元" precision={2} />
                </Tooltip>
              </Card>
            </Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="估算 ARPDAU" value={kpi.arpdau_estimated_cny} suffix="元" precision={2} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="爬塔通关率" value={pct(kpi.tower_clear_rate)} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="窗口最高层" value={kpi.max_floor} suffix="层" /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="塔重置" value={kpi.tower_reset_cnt} suffix="次" /></Card></Col>
          </Row>

          <Text type="secondary">
            这套指标只服务 petTower。花花 / 别捞 / 彩珠走各自的专属接口，改这里不会串数。
          </Text>

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={10}>
              <Card type="inner" title="会话时长分布（重构）">
                {(data?.session_buckets?.length || 0) > 0
                  ? <ReactECharts option={sessionOption} style={{ height: 280 }} />
                  : <Empty description="窗口内拼不出有效会话" />}
              </Card>
            </Col>
            <Col xs={24} lg={14}>
              <Card type="inner" title="逐日时长与广告">
                {daily.length > 0
                  ? <ReactECharts option={dailyOption} style={{ height: 280 }} />
                  : <Empty description="窗口内没有逐日数据" />}
              </Card>
            </Col>
          </Row>

          <Card type="inner" title="通天塔层段：通关率 vs 难度系数">
            {(data?.floor_bands?.length || 0) > 0
              ? <ReactECharts option={bandOption} style={{ height: 320 }} />
              : <Empty description="窗口内没有 tower_floor_* 事件" />}
          </Card>

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={12}>
              <Table
                size="small"
                rowKey="band_label"
                title={() => '层段印记'}
                dataSource={data?.floor_bands || []}
                pagination={false}
                columns={[
                  { title: '层段', dataIndex: 'band_label' },
                  { title: '开始', dataIndex: 'starts', align: 'right' },
                  { title: '通关', dataIndex: 'clears', align: 'right' },
                  { title: '通关率', dataIndex: 'clear_rate', align: 'right', render: pct },
                  { title: '场均印记', dataIndex: 'avg_coins', align: 'right' },
                  { title: '层中难度', dataIndex: 'difficulty_mid', align: 'right' },
                ]}
              />
            </Col>
            <Col xs={24} lg={12}>
              <Table
                size="small"
                rowKey="floor"
                title={() => '卡墙层（≥5 次开始且通关率 <40%）'}
                dataSource={data?.wall_floors || []}
                pagination={false}
                locale={{ emptyText: '窗口内没有达到样本量的卡墙层' }}
                columns={[
                  { title: '层', dataIndex: 'floor', render: (v: number) => `F${v}` },
                  { title: '开始', dataIndex: 'starts', align: 'right' },
                  { title: '通关', dataIndex: 'clears', align: 'right' },
                  { title: '通关率', dataIndex: 'clear_rate', align: 'right', render: pct },
                  { title: '场均印记', dataIndex: 'avg_coins', align: 'right' },
                  { title: '难度', dataIndex: 'difficulty', align: 'right' },
                ]}
              />
            </Col>
          </Row>

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={8}>
              <Table
                size="small"
                rowKey="mode"
                title={() => '战斗耗时对比'}
                dataSource={data?.battle_modes || []}
                pagination={false}
                columns={[
                  { title: '模式', dataIndex: 'mode', render: (v: string) => MODE_LABELS[v] || v },
                  { title: '通关', dataIndex: 'clears', align: 'right' },
                  { title: '场均时长', dataIndex: 'avg_duration_ms', align: 'right', render: formatDuration },
                  { title: '场均回合', dataIndex: 'avg_turns', align: 'right' },
                ]}
              />
            </Col>
            <Col xs={24} lg={8}>
              <Table
                size="small"
                rowKey="scene"
                title={() => '广告位（估算收益）'}
                dataSource={data?.ad_scenes || []}
                pagination={false}
                columns={[
                  { title: '广告位', dataIndex: 'scene', render: (v: string) => SCENE_LABELS[v] || v },
                  { title: '曝光', dataIndex: 'shows', align: 'right' },
                  { title: '完播率', dataIndex: 'complete_rate', align: 'right', render: pct },
                  { title: '估算元', dataIndex: 'revenue_estimated_cny', align: 'right' },
                ]}
              />
            </Col>
            <Col xs={24} lg={8}>
              <Table
                size="small"
                rowKey="option_id"
                title={() => '印记兑换'}
                dataSource={data?.exchanges || []}
                pagination={false}
                locale={{ emptyText: '窗口内没有兑换' }}
                columns={[
                  { title: '商品', dataIndex: 'option_id', render: (v: string) => EXCHANGE_LABELS[v] || v },
                  { title: '次数', dataIndex: 'count', align: 'right' },
                  { title: '印记消耗', dataIndex: 'cost_sum', align: 'right' },
                ]}
              />
            </Col>
          </Row>
        </Space>
      ) : (
        <Empty description="暂无塔2玩法事件。切到 petTower 并选抖音后，窗口内有对局才会出数。" />
      )}
    </Card>
  );
}

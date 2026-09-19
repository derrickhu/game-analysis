import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import ReactECharts from '../components/AnalyticsChart';

import { playerDataCollection } from '../../shared/platforms';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';

import { PetTowerPlayerSnapshotTable } from './PetTowerPlayerSnapshotTable';
import { formatInt, formatPercent } from './utils';

const { Text } = Typography;

interface PetTowerSnapshotKpi {
  user_count: number;
  avg_coins: number;
  max_coins: number;
  avg_lingyu: number;
  max_lingyu: number;
  avg_tickets: number;
  avg_stamina: number;
  avg_owned_pets: number;
  avg_max_pet_level: number;
  avg_stage_clears: number;
  max_chapter: number;
  avg_tower_floor: number;
  max_tower_floor: number;
  tutorial_home_rate: number | null;
  tutorial_drag_rate: number | null;
  sidebar_claimed_rate: number | null;
  checkin_active_rate: number | null;
}

interface LevelBucket {
  level: number;
  user_cnt: number;
}

interface ValueBucket {
  bucket: string;
  user_cnt: number;
  min_value: number;
}

interface DailyTrendPoint {
  date: string;
  user_count: number;
  avg_coins: number;
  avg_lingyu: number;
  avg_stage_clears: number;
  avg_tower_floor: number;
}

interface LatestRun {
  id: number;
  game_key: string;
  collection_name: string;
  snapshot_date: string;
  status: 'running' | 'success' | 'failed';
  started_at: number;
  finished_at: number;
  fetched_count: number;
  inserted_count: number;
  trigger_source: string;
  error_message: string | null;
}

interface SnapshotResponse {
  ok: boolean;
  query?: { game_key: string; snapshot_date: string; has_data: boolean };
  kpi?: PetTowerSnapshotKpi | null;
  chapter_distribution?: LevelBucket[];
  coins_buckets?: ValueBucket[];
  lingyu_buckets?: ValueBucket[];
  tower_buckets?: ValueBucket[];
  daily_trend?: DailyTrendPoint[];
  latest_run?: LatestRun | null;
  source_collection?: string;
  code?: string;
  error?: string;
}

export function PetTowerPlayerSnapshotPanel() {
  const { platform, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const gameKey = 'petTower';
  const [data, setData] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [tableRefreshNonce, setTableRefreshNonce] = useState(0);
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (nextPlatform: string) => {
      const seq = ++requestSeqRef.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({ game: gameKey, platform: nextPlatform });
        const res = await fetch(`/api/realtime/huahua-snapshot?${params.toString()}`);
        const json = (await res.json()) as SnapshotResponse;
        if (seq !== requestSeqRef.current) return;
        if (!json.ok) {
          message.error(`获取玩家快照失败：${json.error || json.code}`);
        }
        setData(json);
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        message.error(`加载玩家快照失败：${String(error)}`);
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [setLastRefreshedAt],
  );

  useEffect(() => {
    void load(platform);
  }, [platform, refreshToken, load]);

  const handleManualPull = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    try {
      const res = await fetch(`/api/realtime/snapshot-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: gameKey, platform }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        snapshot_date?: string;
        fetched?: number;
        inserted?: number;
        duration_ms?: number;
        collection_name?: string;
        error?: string;
      };
      if (json.ok) {
        message.success(
          `拉取完成 ${json.collection_name || ''} ${json.snapshot_date || ''}：${json.fetched || 0} 条 / ${json.duration_ms || 0}ms`,
        );
      } else {
        message.error(`拉取失败：${json.error || '未知错误'}`);
      }
      await load(platform);
      setTableRefreshNonce((v) => v + 1);
    } catch (error) {
      message.error(`拉取请求失败：${String(error)}`);
    } finally {
      setPulling(false);
    }
  }, [platform, load, pulling]);

  const kpi = data?.kpi;
  const hasData = !!data?.query?.has_data && !!kpi && kpi.user_count > 0;
  const snapshotDate = data?.query?.snapshot_date || '-';
  const latestRun = data?.latest_run || undefined;

  const runStatusTag = useMemo(() => {
    if (!latestRun) return null;
    const colorMap = { success: 'green', running: 'blue', failed: 'red' } as const;
    return (
      <Tag color={colorMap[latestRun.status] || 'default'}>
        {latestRun.status === 'success'
          ? '成功'
          : latestRun.status === 'running'
            ? '运行中'
            : '失败'}
      </Tag>
    );
  }, [latestRun]);

  const makeCurrencyBucketOption = (buckets: ValueBucket[], axisName: string, color: string) => ({
    tooltip: {
      trigger: 'axis',
      formatter: (params: Array<{ name: string; value: number }>) => {
        const p = params[0];
        if (!p) return '';
        const total = kpi?.user_count || 0;
        const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : '0';
        return `${p.name}<br/>玩家数：${formatInt(p.value)}（${pct}%）`;
      },
    },
    grid: { left: 60, right: 24, top: 36, bottom: 48 },
    xAxis: {
      type: 'category',
      data: buckets.map((b) => b.bucket),
      name: axisName,
      nameLocation: 'middle' as const,
      nameGap: 32,
      axisLabel: { rotate: buckets.length > 6 ? 30 : 0, hideOverlap: true },
    },
    yAxis: { type: 'value', name: '玩家数', minInterval: 1 },
    series: [
      {
        type: 'bar',
        data: buckets.map((b) => b.user_cnt),
        itemStyle: { color },
        barMaxWidth: 40,
        label: {
          show: true,
          position: 'top' as const,
          formatter: (p: { value: number }) => (p.value > 0 ? String(p.value) : ''),
          fontSize: 11,
        },
      },
    ],
  });

  const coinsBucketOption = useMemo(
    () => makeCurrencyBucketOption(data?.coins_buckets || [], '灵宠币区间', '#d97706'),
    [data?.coins_buckets, kpi?.user_count],
  );

  const lingyuBucketOption = useMemo(
    () => makeCurrencyBucketOption(data?.lingyu_buckets || [], '灵玉区间', '#0f766e'),
    [data?.lingyu_buckets, kpi?.user_count],
  );

  const chapterOption = useMemo(() => {
    const levels = data?.chapter_distribution || [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 30, top: 30, bottom: 40 },
      xAxis: {
        type: 'category',
        data: levels.map((l) => (l.level > 0 ? `第 ${l.level} 章` : '未通关')),
        axisLabel: { hideOverlap: true },
      },
      yAxis: { type: 'value', name: '玩家数', minInterval: 1 },
      series: [
        {
          type: 'bar',
          data: levels.map((l) => l.user_cnt),
          itemStyle: { color: '#2563eb' },
          barMaxWidth: 28,
        },
      ],
    };
  }, [data?.chapter_distribution]);

  const towerBucketOption = useMemo(() => {
    const buckets = data?.tower_buckets || [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 24, top: 30, bottom: 48 },
      xAxis: {
        type: 'category',
        data: buckets.map((b) => b.bucket),
        name: '通天塔最高层',
        nameLocation: 'middle' as const,
        nameGap: 32,
        axisLabel: { hideOverlap: true },
      },
      yAxis: { type: 'value', name: '玩家数', minInterval: 1 },
      series: [
        {
          type: 'bar',
          data: buckets.map((b) => b.user_cnt),
          itemStyle: { color: '#7c3aed' },
          barMaxWidth: 36,
        },
      ],
    };
  }, [data?.tower_buckets]);

  const trendOption = useMemo(() => {
    const trend = data?.daily_trend || [];
    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['人均灵宠币', '人均灵玉', '人均通关'],
        textStyle: { color: '#475569', fontSize: 12, fontWeight: 500 },
        top: 8,
        left: 'center',
      },
      grid: { left: 60, right: 70, top: 50, bottom: 40 },
      xAxis: {
        type: 'category',
        data: trend.map((p) => p.date),
        axisLabel: { hideOverlap: true },
      },
      yAxis: [
        { type: 'value', name: '货币', position: 'left' as const, nameGap: 30 },
        { type: 'value', name: '关/层', position: 'right' as const, nameGap: 30 },
      ],
      series: [
        {
          name: '人均灵宠币',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#d97706' },
          data: trend.map((p) => Math.round(p.avg_coins)),
        },
        {
          name: '人均灵玉',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#0f766e' },
          data: trend.map((p) => Math.round(p.avg_lingyu ?? 0)),
        },
        {
          name: '人均通关',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: '#2563eb' },
          data: trend.map((p) => Number(p.avg_stage_clears.toFixed(1))),
        },
      ],
    };
  }, [data?.daily_trend]);

  const snapshotMeta = [
    `快照日 ${snapshotDate}`,
    `玩家 ${formatInt(kpi?.user_count)}`,
    latestRun
      ? `最近拉取 ${new Date(latestRun.started_at).toLocaleString('zh-CN')}（${latestRun.fetched_count} 条）`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card
      title={
        <Space>
          <Tooltip title="解析 petTower_*_save_v2：灵宠币（主货币/招募）与灵玉（抽卡），以及主线通关、通天塔、签到、引导、侧边栏。每日 04:00 全量拉取云存档集合。">
            <span style={{ cursor: 'help' }}>玩家档案快照</span>
          </Tooltip>
          {runStatusTag}
        </Space>
      }
      extra={
        <Space>
          <Tooltip
            title={`集合：${data?.source_collection || playerDataCollection('petTower', platform)}`}
          >
            <Text type="secondary" style={{ cursor: 'help' }}>
              {snapshotMeta}
            </Text>
          </Tooltip>
          <Button
            icon={<ReloadOutlined />}
            type="primary"
            size="small"
            loading={pulling}
            onClick={handleManualPull}
          >
            立即拉取
          </Button>
        </Space>
      }
      loading={loading && !data}
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        {!hasData ? (
          <Empty
            description={
              <span>
                暂无快照数据。点右上角 <strong>立即拉取</strong> 触发一次全量拉取，或等待 cron（每日 04:00，在花花 / 别捞水果之后串行执行）。
              </span>
            }
          />
        ) : (
          <>
            <Row gutter={[16, 16]}>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="玩家总数" value={formatInt(kpi.user_count)} suffix="人" />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="存档 coins：主线掉落，用于招募 / 商店兑换碎片">
                    <Statistic title="人均灵宠币" value={formatInt(kpi.avg_coins)} />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="最高灵宠币" value={formatInt(kpi.max_coins)} />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="存档 lingyu：抽卡货币，首通 / 图鉴 / 侧边栏产出">
                    <Statistic title="人均灵玉" value={formatInt(kpi.avg_lingyu)} />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="最高灵玉" value={formatInt(kpi.max_lingyu)} />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="人均灵宠数" value={kpi.avg_owned_pets} precision={1} />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="人均主线通关" value={kpi.avg_stage_clears} precision={1} suffix="关" />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="最高章" value={formatInt(kpi.max_chapter)} suffix="章" />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="人均通天塔" value={kpi.avg_tower_floor} precision={1} suffix="层" />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="最高通天塔" value={formatInt(kpi.max_tower_floor)} suffix="层" />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="主页引导完成率" value={formatPercent(kpi.tutorial_home_rate)} />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="侧边栏领奖率" value={formatPercent(kpi.sidebar_claimed_rate)} />
                </Card>
              </Col>
            </Row>

            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Card size="small" title="灵宠币存量分布">
                  <ReactECharts option={coinsBucketOption} style={{ height: 280 }} />
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card size="small" title="灵玉存量分布">
                  <ReactECharts option={lingyuBucketOption} style={{ height: 280 }} />
                </Card>
              </Col>
            </Row>

            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Card size="small" title="主线最高章分布">
                  <ReactECharts option={chapterOption} style={{ height: 280 }} />
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card size="small" title="通天塔最高层分布">
                  <ReactECharts option={towerBucketOption} style={{ height: 280 }} />
                </Card>
              </Col>
            </Row>

            <Card size="small" title="最近 30 天每日趋势">
              <ReactECharts option={trendOption} style={{ height: 280 }} />
            </Card>

            <PetTowerPlayerSnapshotTable
              snapshotDate={snapshotDate}
              globalPlatform={platform}
              refreshNonce={tableRefreshNonce}
            />
          </>
        )}
      </Space>
    </Card>
  );
}

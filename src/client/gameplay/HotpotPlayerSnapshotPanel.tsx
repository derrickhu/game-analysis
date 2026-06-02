import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
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
import ReactECharts from 'echarts-for-react';

import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';

import { HotpotPlayerSnapshotTable } from './HotpotPlayerSnapshotTable';
import { formatInt } from './utils';

const { Text } = Typography;

interface HotpotSnapshotKpi {
  user_count: number;
  avg_coins: number;
  max_coins: number;
  median_coins: number;
  avg_coins_earned: number;
  avg_coins_spent: number;
  avg_bowl_badge_level: number;
  max_bowl_badge_level: number;
  avg_fruit_best_score: number;
  max_fruit_best_score: number;
  avg_gacha_pulls: number;
  avg_bowl_tool_total: number;
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
  avg_bowl_badge_level: number;
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
  kpi?: HotpotSnapshotKpi | null;
  bowl_level_distribution?: LevelBucket[];
  coins_buckets?: ValueBucket[];
  daily_trend?: DailyTrendPoint[];
  latest_run?: LatestRun | null;
  code?: string;
  error?: string;
}

/**
 * 别捞水果玩家档案快照面板：每日全量 hotpot_playerData → hotpot_player_snapshots。
 */
export function HotpotPlayerSnapshotPanel() {
  const { refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const gameKey = 'hotpot';
  const [data, setData] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [tableRefreshNonce, setTableRefreshNonce] = useState(0);
  const requestSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/realtime/huahua-snapshot?game=${gameKey}`);
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
  }, [setLastRefreshedAt]);

  useEffect(() => {
    void load();
  }, [refreshToken, load]);

  const handleManualPull = useCallback(async () => {
    if (pulling) return;
    setPulling(true);
    try {
      const res = await fetch(`/api/realtime/snapshot-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: gameKey }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        snapshot_date?: string;
        fetched?: number;
        inserted?: number;
        duration_ms?: number;
        error?: string;
      };
      if (json.ok) {
        message.success(
          `拉取完成 ${json.snapshot_date || ''}：${json.fetched || 0} 条 / ${json.duration_ms || 0}ms`,
        );
      } else {
        message.error(`拉取失败：${json.error || '未知错误'}`);
      }
      await load();
      setTableRefreshNonce((v) => v + 1);
    } catch (error) {
      message.error(`拉取请求失败：${String(error)}`);
    } finally {
      setPulling(false);
    }
  }, [load, pulling]);

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

  const coinsBucketOption = useMemo(() => {
    const buckets = data?.coins_buckets || [];
    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: Array<{ name: string; value: number; dataIndex: number }>) => {
          const p = params[0];
          if (!p) return '';
          const b = buckets[p.dataIndex];
          const total = kpi?.user_count || 0;
          const pct = total > 0 ? ((p.value / total) * 100).toFixed(1) : '0';
          return `${p.name}<br/>玩家数：${formatInt(p.value)}（${pct}%）`;
        },
      },
      grid: { left: 60, right: 24, top: 36, bottom: 48 },
      xAxis: {
        type: 'category',
        data: buckets.map((b) => b.bucket),
        name: '金币区间',
        nameLocation: 'middle' as const,
        nameGap: 32,
        axisLabel: { rotate: buckets.length > 6 ? 30 : 0, hideOverlap: true },
      },
      yAxis: { type: 'value', name: '玩家数', minInterval: 1 },
      series: [
        {
          type: 'bar',
          data: buckets.map((b) => b.user_cnt),
          itemStyle: { color: '#f59e0b' },
          barMaxWidth: 40,
          label: {
            show: true,
            position: 'top' as const,
            formatter: (p: { value: number }) => (p.value > 0 ? String(p.value) : ''),
            fontSize: 11,
          },
        },
      ],
    };
  }, [data?.coins_buckets, kpi?.user_count]);

  const bowlLevelOption = useMemo(() => {
    const levels = data?.bowl_level_distribution || [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 30, top: 30, bottom: 40 },
      xAxis: {
        type: 'category',
        data: levels.map((l) => `第 ${l.level} 关`),
        axisLabel: { hideOverlap: true },
      },
      yAxis: { type: 'value', name: '玩家数', minInterval: 1 },
      series: [
        {
          type: 'bar',
          data: levels.map((l) => l.user_cnt),
          itemStyle: { color: '#3b82f6' },
          barMaxWidth: 28,
        },
      ],
    };
  }, [data?.bowl_level_distribution]);

  const trendOption = useMemo(() => {
    const trend = data?.daily_trend || [];
    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['人均金币', '人均主线通关'],
        textStyle: { color: '#374151', fontSize: 12, fontWeight: 500 },
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
        { type: 'value', name: '金币', position: 'left' as const, nameGap: 30 },
        { type: 'value', name: '关卡', position: 'right' as const, nameGap: 30 },
      ],
      series: [
        {
          name: '人均金币',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#f59e0b' },
          data: trend.map((p) => Math.round(p.avg_coins)),
        },
        {
          name: '人均主线通关',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: '#3b82f6' },
          data: trend.map((p) => Number(p.avg_bowl_badge_level.toFixed(1))),
        },
      ],
    };
  }, [data?.daily_trend]);

  return (
    <Card
      title={
        <Space>
          <span>玩家档案快照</span>
          {runStatusTag}
        </Space>
      }
      extra={
        <Space>
          <Text type="secondary">数据源：每日 04:00 全量拉取 {`hotpot_playerData`} 集合</Text>
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
        <Alert
          showIcon
          type="info"
          message={
            <span>
              当前快照日期：<strong>{snapshotDate}</strong> / 玩家总数：
              <strong>{formatInt(kpi?.user_count)}</strong>
              {latestRun && (
                <>
                  {' '}
                  / 最近一次拉取：{new Date(latestRun.started_at).toLocaleString('zh-CN')}（
                  {latestRun.fetched_count} 条，
                  {latestRun.finished_at > 0
                    ? `${latestRun.finished_at - latestRun.started_at}ms`
                    : '-'}
                  ）
                </>
              )}
            </span>
          }
          description="本看板解析 hotpot_wallet_v1 等存档字段，重点观察金币存量分布与主线进度横切面。"
        />

        {!hasData ? (
          <Empty
            description={
              <span>
                暂无快照数据。点右上角 <strong>立即拉取</strong> 触发一次全量拉取，或等待 cron（每日 04:00，在花花之后串行执行）。
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
                  <Tooltip title="hotpot_wallet_v1.coins 算数平均">
                    <Statistic title="人均金币" value={formatInt(kpi.avg_coins)} />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="中位金币" value={formatInt(kpi.median_coins)} />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="最高金币" value={formatInt(kpi.max_coins)} />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="人均累计获得" value={formatInt(kpi.avg_coins_earned)} />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="人均累计花费" value={formatInt(kpi.avg_coins_spent)} />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic
                    title="人均主线通关"
                    value={kpi.avg_bowl_badge_level}
                    precision={1}
                    suffix="关"
                  />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="最高主线通关" value={formatInt(kpi.max_bowl_badge_level)} suffix="关" />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="人均果切最高分" value={formatInt(kpi.avg_fruit_best_score)} />
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Statistic title="人均扭蛋次数" value={formatInt(kpi.avg_gacha_pulls)} suffix="次" />
                </Card>
              </Col>
            </Row>

            <Card size="small" title="金币数量分布（按当前余额分桶）">
              <ReactECharts option={coinsBucketOption} style={{ height: 300 }} />
            </Card>

            <Row gutter={[16, 16]}>
              <Col xs={24} md={12}>
                <Card size="small" title="主线通关分布（bowl_badge_level）">
                  <ReactECharts option={bowlLevelOption} style={{ height: 280 }} />
                </Card>
              </Col>
              <Col xs={24} md={12}>
                <Card size="small" title="最近 30 天每日趋势">
                  <ReactECharts option={trendOption} style={{ height: 280 }} />
                </Card>
              </Col>
            </Row>

            <HotpotPlayerSnapshotTable snapshotDate={snapshotDate} refreshNonce={tableRefreshNonce} />
          </>
        )}
      </Space>
    </Card>
  );
}

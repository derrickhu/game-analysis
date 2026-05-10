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
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';

import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';

import { PlayerSnapshotTable } from './PlayerSnapshotTable';
import { formatInt, formatPercent } from './utils';

const { Text } = Typography;

interface SnapshotKpi {
  user_count: number;
  avg_level: number;
  max_level: number;
  avg_huayuan: number;
  avg_diamond: number;
  avg_stamina: number;
  avg_flower_sign_tickets: number;
  tutorial_completed_rate: number | null;
  avg_total_merges: number;
  avg_total_orders: number;
  checkin_active_rate: number | null;
  avg_checkin_streak: number;
  avg_unlocked_deco: number;
  avg_unlocked_room_styles: number;
  avg_unlocked_outfit: number;
  avg_affinity_cards_owned: number;
  avg_collection_discovered: number;
  avg_active_customers: number;
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

interface TutorialStepBucket {
  step: number;
  user_cnt: number;
  completed: 0 | 1;
}

interface DailyTrendPoint {
  date: string;
  user_count: number;
  avg_level: number;
  avg_huayuan: number;
  avg_diamond: number;
  tutorial_completed_rate: number | null;
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
  kpi?: SnapshotKpi | null;
  level_distribution?: LevelBucket[];
  huayuan_buckets?: ValueBucket[];
  diamond_buckets?: ValueBucket[];
  deco_buckets?: ValueBucket[];
  tutorial_steps?: TutorialStepBucket[];
  daily_trend?: DailyTrendPoint[];
  latest_run?: LatestRun | null;
  code?: string;
  error?: string;
}

/**
 * 花花玩家档案快照面板。
 *
 * 与其他面板的 3 个核心差异：
 *   1. 数据源是每天 04:00 全量拉的 huahua_player_snapshots（DB 横切面），不是 5 分钟事件桶
 *   2. 不响应全局时间窗口选择 —— "今天的快照就是今天的状态"，时间窗口对快照无意义
 *   3. 顶部提供"立即拉取"按钮，联调和数据修正用（生产由 cron 自动触发）
 *
 * KPI 视角对照：
 *   - 事件流 panels：本窗口内"做了 X 次合成 / 交付 N 单"——增量
 *   - 本 panel：现在所有玩家"平均累计合成 K 次 / 平均星级 L"——存量
 *
 * 数据接口：
 *   - GET  /api/realtime/huahua-snapshot   读快照 + 30 天趋势
 *   - POST /api/realtime/snapshot-now      手动触发一次全量拉取
 */
export function PlayerSnapshotPanel() {
  const { gameKey, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<SnapshotResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pulling, setPulling] = useState(false);
  // 用单调递增 nonce 通知子表格"该重拉了"——比传 Date.now 更稳定，也避免重复触发
  const [tableRefreshNonce, setTableRefreshNonce] = useState(0);
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (nextGameKey: string) => {
      const seq = ++requestSeqRef.current;
      setLoading(true);
      try {
        const res = await fetch(
          `/api/realtime/huahua-snapshot?game=${encodeURIComponent(nextGameKey)}`,
        );
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
    void load(gameKey);
  }, [gameKey, refreshToken, load]);

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
      // 拉完重新查一次，刷新看板 + 通知子表格也重拉
      await load(gameKey);
      setTableRefreshNonce((v) => v + 1);
    } catch (error) {
      message.error(`拉取请求失败：${String(error)}`);
    } finally {
      setPulling(false);
    }
  }, [gameKey, load, pulling]);

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

  // 星级分布柱状图：x=星级、y=玩家数
  const levelOption = useMemo(() => {
    const levels = data?.level_distribution || [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 50, right: 30, top: 30, bottom: 40 },
      xAxis: {
        type: 'category',
        data: levels.map((l) => `Lv.${l.level}`),
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
  }, [data?.level_distribution]);

  // 花愿/钻石/装饰分桶柱状图：3 个图共用 option 工厂
  const buildBucketOption = (
    title: string,
    buckets: ValueBucket[],
    color: string,
  ) => ({
    tooltip: { trigger: 'axis' },
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    xAxis: {
      type: 'category',
      data: buckets.map((b) => b.bucket),
      name: title,
      nameLocation: 'middle' as const,
      nameGap: 28,
    },
    yAxis: { type: 'value', name: '玩家数', minInterval: 1 },
    series: [
      {
        type: 'bar',
        data: buckets.map((b) => b.user_cnt),
        itemStyle: { color },
        barMaxWidth: 36,
      },
    ],
  });

  const huayuanBucketOption = useMemo(
    () => buildBucketOption('花愿余额', data?.huayuan_buckets || [], '#10b981'),
    [data?.huayuan_buckets],
  );
  const diamondBucketOption = useMemo(
    () => buildBucketOption('钻石余额', data?.diamond_buckets || [], '#a855f7'),
    [data?.diamond_buckets],
  );
  const decoBucketOption = useMemo(
    () => buildBucketOption('已解锁家具数', data?.deco_buckets || [], '#f59e0b'),
    [data?.deco_buckets],
  );

  // 30 天趋势：双 Y 轴 折线
  // legend 显式放顶部，留够 grid.top 空间，避免在 series 数据点稀疏（只有 1 天）时
  // legend 跟图表底部 X 轴重叠
  const trendOption = useMemo(() => {
    const trend = data?.daily_trend || [];
    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['平均星级', '人均花愿', '教程完成率'],
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
        { type: 'value', name: '星级 / 完成率', position: 'left' as const, nameGap: 30 },
        { type: 'value', name: '花愿', position: 'right' as const, nameGap: 30 },
      ],
      series: [
        {
          name: '平均星级',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#3b82f6' },
          data: trend.map((p) => p.avg_level),
        },
        {
          name: '人均花愿',
          type: 'line',
          smooth: true,
          yAxisIndex: 1,
          itemStyle: { color: '#10b981' },
          data: trend.map((p) => p.avg_huayuan),
        },
        {
          name: '教程完成率',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#f59e0b' },
          data: trend.map((p) =>
            p.tutorial_completed_rate === null ? null : Number((p.tutorial_completed_rate * 100).toFixed(1)),
          ),
        },
      ],
    };
  }, [data?.daily_trend]);

  // 教程停留分布表格
  const tutorialColumns = [
    { title: '步骤', dataIndex: 'step', key: 'step', render: (v: number) => `Step ${v}` },
    { title: '玩家数', dataIndex: 'user_cnt', key: 'user_cnt', align: 'right' as const, render: formatInt },
    {
      title: '是否已完成',
      dataIndex: 'completed',
      key: 'completed',
      render: (v: 0 | 1) => (v === 1 ? <Tag color="green">已完成</Tag> : <Tag>引导中</Tag>),
    },
  ];

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
          <Text type="secondary">
            数据源：每日 04:00 全量拉取 {`huahua_playerData`} 集合
          </Text>
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
                  {' '}/ 最近一次拉取：{new Date(latestRun.started_at).toLocaleString('zh-CN')}（
                  {latestRun.fetched_count} 条，
                  {latestRun.finished_at > 0 ? `${latestRun.finished_at - latestRun.started_at}ms` : '-'}）
                </>
              )}
            </span>
          }
          description="本看板与 5 分钟事件流互补：事件流看「做了什么」（增量），快照看「现在是什么状态」（绝对值存量）。"
        />

        {!hasData ? (
          <Empty
            description={
              <span>
                暂无快照数据。点右上角 <strong>立即拉取</strong> 触发一次全量拉取，或等待 cron（每日 04:00）。
              </span>
            }
          />
        ) : (
          <>
            <Row gutter={[16, 16]}>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="本次快照中所有玩家档案数">
                    <Statistic title="玩家总数" value={formatInt(kpi.user_count)} suffix="人" />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="所有玩家当前星级（currency.level）的算数平均">
                    <Statistic title="平均星级" value={kpi.avg_level} suffix="级" />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="任意玩家在快照中的最高星级">
                    <Statistic title="最高星级" value={formatInt(kpi.max_level)} suffix="级" />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="tutorial_completed = 1 的玩家占比，对应客户端引导走完最后一步的人">
                    <Statistic
                      title="教程完成率"
                      value={formatPercent(kpi.tutorial_completed_rate)}
                    />
                  </Tooltip>
                </Card>
              </Col>

              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="花愿余额（save.currency.huayuan）的人均存量">
                    <Statistic title="人均花愿" value={formatInt(kpi.avg_huayuan)} />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="钻石余额的人均存量">
                    <Statistic title="人均钻石" value={formatInt(kpi.avg_diamond)} />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="体力余额的人均存量（最大值通常是 5 ~ 上限值之间）">
                    <Statistic title="人均体力" value={formatInt(kpi.avg_stamina)} />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="许愿券（flowerSignTickets）人均余额，反映抽奖留存">
                    <Statistic title="人均许愿券" value={formatInt(kpi.avg_flower_sign_tickets)} />
                  </Tooltip>
                </Card>
              </Col>

              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="merge_stats.totalMerges 字段的人均累计合成数">
                    <Statistic title="人均累计合成" value={formatInt(kpi.avg_total_merges)} suffix="次" />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="merge_stats.totalOrders 字段的人均累计交付订单">
                    <Statistic title="人均累计订单" value={formatInt(kpi.avg_total_orders)} suffix="单" />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="checkin_total_days > 0 的玩家占比 —— 至少签到过一次">
                    <Statistic
                      title="签到活跃率"
                      value={formatPercent(kpi.checkin_active_rate)}
                    />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="所有玩家的 consecutiveDays 平均（已断签的玩家也包括，会拉低均值）">
                    <Statistic title="平均连续签到" value={kpi.avg_checkin_streak} suffix="天" />
                  </Tooltip>
                </Card>
              </Col>

              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="decoration.unlocked 数组人均长度，反映商城渗透">
                    <Statistic title="人均家具解锁" value={kpi.avg_unlocked_deco} suffix="件" />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="decoration.unlockedRoomStyles 数组人均长度">
                    <Statistic
                      title="人均房间风格"
                      value={kpi.avg_unlocked_room_styles}
                      suffix="款"
                    />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="dressup.unlocked 数组人均长度（换装系统）">
                    <Statistic title="人均换装解锁" value={kpi.avg_unlocked_outfit} suffix="件" />
                  </Tooltip>
                </Card>
              </Col>
              <Col xs={12} md={6}>
                <Card size="small">
                  <Tooltip title="affinity_cards.owners 字典 key 总数（不计重复张数）">
                    <Statistic
                      title="人均熟客卡"
                      value={kpi.avg_affinity_cards_owned}
                      suffix="张"
                    />
                  </Tooltip>
                </Card>
              </Col>
            </Row>

            {/* 星级分布 */}
            <Card size="small" title="星级分布（按当前 currency.level 横切面）">
              <ReactECharts option={levelOption} style={{ height: 280 }} />
            </Card>

            {/* 花愿 / 钻石 / 装饰 三联分桶 */}
            <Row gutter={[16, 16]}>
              <Col xs={24} md={8}>
                <Card size="small" title="花愿余额分桶">
                  <ReactECharts option={huayuanBucketOption} style={{ height: 240 }} />
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card size="small" title="钻石余额分桶">
                  <ReactECharts option={diamondBucketOption} style={{ height: 240 }} />
                </Card>
              </Col>
              <Col xs={24} md={8}>
                <Card size="small" title="家具解锁分桶">
                  <ReactECharts option={decoBucketOption} style={{ height: 240 }} />
                </Card>
              </Col>
            </Row>

            {/* 教程停留 */}
            <Card size="small" title="新手引导停留分布（按 tutorial.step 字段）">
              <Table
                dataSource={data?.tutorial_steps || []}
                columns={tutorialColumns}
                rowKey={(r) => `${r.step}-${r.completed}`}
                pagination={false}
                size="small"
              />
            </Card>

            {/* 30 天趋势 */}
            <Card size="small" title="最近 30 天每日趋势（横切面平均）">
              <ReactECharts option={trendOption} style={{ height: 320 }} />
            </Card>

            {/* 玩家明细：服务端排序 + 筛选 + 分页 */}
            <PlayerSnapshotTable
              gameKey={gameKey}
              snapshotDate={snapshotDate}
              refreshNonce={tableRefreshNonce}
            />
          </>
        )}
      </Space>
    </Card>
  );
}

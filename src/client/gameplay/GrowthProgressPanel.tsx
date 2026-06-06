import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Card, Col, Empty, Row, Space, Statistic, Table, Tooltip, Typography, message } from 'antd';
import ReactECharts from 'echarts-for-react';

import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { buildWindowQuery, type WindowValue } from '../timeWindow';

import {
  CHART_GRID_WITH_ZOOM,
  CHART_LEGEND_TOP,
  formatInt,
  formatPercent,
  makeDataZoom,
} from './utils';

const { Text } = Typography;

interface StarLevelRow {
  to_level: number;
  user_cnt: number;
  event_cnt: number;
}

interface TutorialStepRow {
  step_id: string;
  user_cnt: number;
  event_cnt: number;
  avg_duration_ms: number;
}

interface GrowthKpi {
  total_level_ups: number;
  level_up_users: number;
  max_level_reached: number;
  new_users: number;
  new_user_tutorial_started_users: number;
  new_user_tutorial_completed_users: number;
  new_user_order_deliver_users: number;
  new_user_ad_show_users: number;
  new_user_tutorial_complete_rate: number | null;
  new_user_tutorial_start_rate: number | null;
  new_user_order_deliver_rate: number | null;
  new_user_ad_show_rate: number | null;
  computed_at: number;
}

interface GrowthResponse {
  ok: boolean;
  query?: { game_key: string; from: string; to: string; window_minutes: number };
  kpi?: GrowthKpi;
  level_distribution?: StarLevelRow[];
  tutorial_funnel?: TutorialStepRow[];
  code?: string;
  error?: string;
}

function formatDuration(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '-';
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const remain = sec % 60;
  return `${min} 分 ${remain} 秒`;
}

/**
 * 新手引导 + 首日 cohort 漏斗（玩法分析第一面板）。
 *
 * 优化游戏时优先看「新用户 cohort」：
 *   - 分母 = 窗口内首次 session_start 的用户（不含老用户回访稀释）
 *   - 教程完成 / 首单 / 看广告 = 该 cohort 生命周期内是否达成
 */
export function GrowthProgressPanel() {
  const { gameKey, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<GrowthResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (nextGameKey: string, nextWindow: WindowValue) => {
      const seq = ++requestSeqRef.current;
      try {
        const queryStr = buildWindowQuery(nextWindow);
        const res = await fetch(
          `/api/realtime/huahua-growth?game=${encodeURIComponent(nextGameKey)}&${queryStr}`,
        );
        const json = (await res.json()) as GrowthResponse;
        if (seq !== requestSeqRef.current) return;
        if (!json.ok) {
          message.error(`获取成长数据失败：${json.error || json.code}`);
        }
        setData(json);
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        message.error(`加载成长数据失败：${String(error)}`);
      }
    },
    [setLastRefreshedAt],
  );

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, windowSel, refreshToken, load]);

  const levelDist = data?.level_distribution || [];
  const tutorial = data?.tutorial_funnel || [];
  const kpi = data?.kpi;

  const levelDistOption = useMemo(() => {
    const xAxis = levelDist.map((d) => `Lv.${d.to_level}`);
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any[]) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const lv = params[0].axisValue;
          const row = levelDist[params[0].dataIndex];
          if (!row) return lv;
          return `${lv}<br/>到达用户：${row.user_cnt}<br/>升级次数：${row.event_cnt}`;
        },
      },
      legend: { data: ['到达用户', '升级次数'], ...CHART_LEGEND_TOP },
      grid: CHART_GRID_WITH_ZOOM,
      xAxis: { type: 'category', data: xAxis, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', name: '人数 / 次数', minInterval: 1 },
      dataZoom: makeDataZoom(),
      series: [
        {
          name: '到达用户',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] },
          data: levelDist.map((d) => d.user_cnt),
        },
        {
          name: '升级次数',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#94a3b8', borderRadius: [4, 4, 0, 0] },
          data: levelDist.map((d) => d.event_cnt),
        },
      ],
    };
  }, [levelDist]);

  const tutorialOption = useMemo(() => {
    if (tutorial.length === 0) return null;
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} 人' },
      series: [
        {
          type: 'funnel',
          left: '10%',
          right: '10%',
          top: 30,
          bottom: 30,
          minSize: '15%',
          maxSize: '95%',
          sort: 'none',
          gap: 4,
          label: { show: true, position: 'inside', color: '#fff', fontWeight: 600 },
          data: tutorial.map((s) => ({
            name: s.step_id,
            value: s.user_cnt,
          })),
        },
      ],
    };
  }, [tutorial]);

  const tutorialColumns = [
    { title: '引导步骤', dataIndex: 'step_id', key: 'step_id' },
    {
      title: '完成用户数',
      dataIndex: 'user_cnt',
      key: 'user_cnt',
      align: 'right' as const,
      render: (v: number) => formatInt(v),
    },
    {
      title: '事件数',
      dataIndex: 'event_cnt',
      key: 'event_cnt',
      align: 'right' as const,
      render: (v: number) => formatInt(v),
    },
    {
      title: '平均耗时',
      dataIndex: 'avg_duration_ms',
      key: 'avg_duration_ms',
      align: 'right' as const,
      render: (v: number) => formatDuration(v),
    },
  ];

  return (
    <Card
      title="新手引导 + 首日 cohort（优化优先）"
      extra={<Text type="secondary">数据源：session_start / tutorial_step / order_deliver / ad_show</Text>}
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="优化游戏先看这里"
          description={
            <>
              核心分母是<strong>窗口内首次进游戏的新用户</strong>（不含老用户回访）。
              优先提升「进入引导 → 完成教程 → 首单 → 看广告」；下方等级成长为长期参考。
            </>
          }
        />

        <Card type="inner" title="新用户 cohort（核心优化指标）" size="small">
          <Row gutter={[16, 16]}>
            <Col xs={12} md={8} lg={4}>
              <Tooltip title="窗口内首次 session_start 的去重用户数，与大盘「窗口内新增」同口径">
                <Statistic title="新用户" value={formatInt(kpi?.new_users)} suffix="人" />
              </Tooltip>
            </Col>
            <Col xs={12} md={8} lg={4}>
              <Tooltip title="新用户中曾完成 tutorial_completed 的比例（全生命周期）">
                <Statistic
                  title="新用户教程完成率"
                  value={formatPercent(kpi?.new_user_tutorial_complete_rate)}
                  valueStyle={{ color: '#1677ff', fontWeight: 700 }}
                />
              </Tooltip>
            </Col>
            <Col xs={12} md={8} lg={4}>
              <Tooltip title="新用户中窗口内至少触发过 1 次 tutorial_step(done)">
                <Statistic
                  title="进入引导率"
                  value={formatPercent(kpi?.new_user_tutorial_start_rate)}
                />
              </Tooltip>
            </Col>
            <Col xs={12} md={8} lg={4}>
              <Tooltip title="新用户中曾 order_deliver 的比例">
                <Statistic
                  title="首单交付率"
                  value={formatPercent(kpi?.new_user_order_deliver_rate)}
                />
              </Tooltip>
            </Col>
            <Col xs={12} md={8} lg={4}>
              <Tooltip title="新用户中曾 ad_show 的比例，接近变现漏斗">
                <Statistic
                  title="看广告率"
                  value={formatPercent(kpi?.new_user_ad_show_rate)}
                />
              </Tooltip>
            </Col>
            <Col xs={12} md={8} lg={4}>
              <Statistic
                title="完成教程"
                value={formatInt(kpi?.new_user_tutorial_completed_users)}
                suffix="人"
              />
            </Col>
          </Row>
        </Card>

        <Row gutter={[16, 16]}>
          <Col xs={24} lg={10}>
            <Card type="inner" title="新手引导漏斗（窗口内步骤）">
              {tutorialOption ? (
                <ReactECharts option={tutorialOption} style={{ height: 320 }} />
              ) : (
                <Empty description="窗口内还没有 tutorial_step 事件" />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={14}>
            <Card type="inner" title="引导步骤明细（查卡在哪一步）">
              <Table
                size="small"
                dataSource={tutorial}
                rowKey="step_id"
                pagination={false}
                columns={tutorialColumns}
                locale={{ emptyText: '暂无引导步骤数据' }}
              />
            </Card>
          </Col>
        </Row>

        <Card type="inner" title="等级成长（长期参考）">
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={12} md={8}>
              <Statistic title="升级总次数" value={formatInt(kpi?.total_level_ups)} suffix="次" />
            </Col>
            <Col xs={12} md={8}>
              <Statistic title="升级用户数" value={formatInt(kpi?.level_up_users)} suffix="人" />
            </Col>
            <Col xs={12} md={8}>
              <Statistic title="最高等级" value={formatInt(kpi?.max_level_reached)} suffix="级" />
            </Col>
          </Row>
          {levelDist.length > 0 ? (
            <ReactECharts option={levelDistOption} style={{ height: 280 }} />
          ) : (
            <Empty description="窗口内还没有等级升级数据" />
          )}
        </Card>
      </Space>
    </Card>
  );
}

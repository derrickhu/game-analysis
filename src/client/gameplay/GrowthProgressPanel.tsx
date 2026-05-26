import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Col, Empty, Row, Space, Statistic, Table, Tooltip, Typography, message } from 'antd';
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
  tutorial_completed_users: number;
  session_users: number;
  tutorial_complete_rate: number | null;
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
 * 星级成长 + 新手引导漏斗。
 *
 * 关注点：
 *   - 升星节奏：哪些星级有突变？是不是某档卡了一周？
 *   - 教程完成率：=（教程完成用户）/（启动用户），用作首日留存代理指标
 *   - 教程各步耗时：哪一步玩家停留最久（可能 UI 卡住或描述不清）
 *
 * 数据源：/api/realtime/huahua-growth
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
          return `${lv}<br/>到达用户：${row.user_cnt}<br/>升星事件：${row.event_cnt}`;
        },
      },
      legend: { data: ['到达用户', '升星事件'], ...CHART_LEGEND_TOP },
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
          name: '升星事件',
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
          sort: 'descending',
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
      title="星级成长 + 新手引导漏斗"
      extra={<Text type="secondary">数据源：star_level_up / tutorial_step / session_start</Text>}
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="窗口内 star_level_up 事件总次数">
                <Statistic title="升星总次数" value={formatInt(kpi?.total_level_ups)} suffix="次" />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="升星用户数" value={formatInt(kpi?.level_up_users)} suffix="人" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="窗口内 star_level_up 事件中最大的 new_level">
                <Statistic title="最高星级" value={formatInt(kpi?.max_level_reached)} suffix="级" />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="= 教程完成用户 / 窗口内 session_start 用户。粗略代理首日 1 日留存">
                <Statistic
                  title="教程完成率"
                  value={formatPercent(kpi?.tutorial_complete_rate)}
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="教程完成用户"
                value={formatInt(kpi?.tutorial_completed_users)}
                suffix="人"
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="启动用户（分母）"
                value={formatInt(kpi?.session_users)}
                suffix="人"
              />
            </Card>
          </Col>
        </Row>

        <Card type="inner" title="星级分布（按到达星级聚合）">
          {levelDist.length > 0 ? (
            <ReactECharts option={levelDistOption} style={{ height: 320 }} />
          ) : (
            <Empty description="窗口内还没有星级升级数据" />
          )}
        </Card>

        <Row gutter={[16, 16]}>
          <Col xs={24} lg={10}>
            <Card type="inner" title="新手引导漏斗">
              {tutorialOption ? (
                <ReactECharts option={tutorialOption} style={{ height: 320 }} />
              ) : (
                <Empty description="窗口内还没有 tutorial_step 事件" />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={14}>
            <Card type="inner" title="引导步骤明细">
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
      </Space>
    </Card>
  );
}

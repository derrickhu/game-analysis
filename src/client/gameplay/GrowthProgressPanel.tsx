import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Card, Col, Empty, Row, Space, Statistic, Tooltip, Typography, message } from 'antd';
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

interface NewUserTutorialDailyPoint {
  date: string;
  new_users: number;
  new_user_tutorial_completed_users: number;
  new_user_tutorial_started_users: number;
  new_user_order_deliver_users: number;
  new_user_ad_show_users: number;
  new_user_tutorial_complete_rate: number | null;
  new_user_tutorial_start_rate: number | null;
  new_user_order_deliver_rate: number | null;
  new_user_ad_show_rate: number | null;
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
  new_user_tutorial_daily?: NewUserTutorialDailyPoint[];
  code?: string;
  error?: string;
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
  const tutorialDaily = data?.new_user_tutorial_daily ?? [];
  const tutorialDailyMissing = Boolean(data?.ok && data.new_user_tutorial_daily === undefined);
  const coreDailyStale = Boolean(
    data?.ok &&
      tutorialDaily.length > 0 &&
      tutorialDaily.some((p) => p.new_user_tutorial_start_rate === undefined),
  );
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

  const rateToPct = (value: number | null | undefined) =>
    value === null || value === undefined ? null : Number((value * 100).toFixed(1));

  /** 近 7 天：柱 = 新用户基数，线 = 四项 cohort 转化率 */
  const tutorialDailyOption = useMemo(() => {
    const lineSeries = [
      { name: '教程完成率', key: 'new_user_tutorial_complete_rate' as const, color: '#1677ff' },
      { name: '进入引导率', key: 'new_user_tutorial_start_rate' as const, color: '#10b981' },
      { name: '首单交付率', key: 'new_user_order_deliver_rate' as const, color: '#f59e0b' },
      { name: '看广告率', key: 'new_user_ad_show_rate' as const, color: '#8b5cf6' },
    ];
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: any[]) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const idx = params[0].dataIndex;
          const row = tutorialDaily[idx];
          if (!row) return '';
          return [
            row.date,
            `新用户：${formatInt(row.new_users)} 人`,
            `完成教程：${formatInt(row.new_user_tutorial_completed_users)} 人`,
            `进入引导：${formatInt(row.new_user_tutorial_started_users)} 人`,
            `首单交付：${formatInt(row.new_user_order_deliver_users)} 人`,
            `看广告：${formatInt(row.new_user_ad_show_users)} 人`,
            `教程完成率：${formatPercent(row.new_user_tutorial_complete_rate)}`,
            `进入引导率：${formatPercent(row.new_user_tutorial_start_rate)}`,
            `首单交付率：${formatPercent(row.new_user_order_deliver_rate)}`,
            `看广告率：${formatPercent(row.new_user_ad_show_rate)}`,
          ].join('<br/>');
        },
      },
      legend: {
        data: ['新用户', ...lineSeries.map((s) => s.name)],
        ...CHART_LEGEND_TOP,
      },
      grid: { left: 56, right: 56, top: 72, bottom: 40 },
      xAxis: {
        type: 'category',
        data: tutorialDaily.map((p) => p.date.slice(5)),
        name: '日期',
        nameLocation: 'middle' as const,
        nameGap: 28,
      },
      yAxis: [
        {
          type: 'value',
          name: '转化率',
          min: 0,
          max: 100,
          axisLabel: { formatter: '{value}%' },
        },
        {
          type: 'value',
          name: '新用户',
          minInterval: 1,
          position: 'right' as const,
          nameGap: 36,
        },
      ],
      series: [
        {
          name: '新用户',
          type: 'bar',
          yAxisIndex: 1,
          barMaxWidth: 28,
          itemStyle: { color: '#cbd5e1', borderRadius: [4, 4, 0, 0] },
          data: tutorialDaily.map((p) => p.new_users),
        },
        ...lineSeries.map((s) => ({
          name: s.name,
          type: 'line' as const,
          smooth: true,
          symbolSize: 6,
          lineStyle: { width: 2 },
          itemStyle: { color: s.color },
          data: tutorialDaily.map((p) => rateToPct(p[s.key])),
        })),
      ],
    };
  }, [tutorialDaily]);

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
            <Col xs={12} md={8} lg={6}>
              <Tooltip title="窗口内首次 session_start 的去重用户数，与大盘「窗口内新增」同口径">
                <Statistic title="新用户" value={formatInt(kpi?.new_users)} suffix="人" />
              </Tooltip>
            </Col>
            <Col xs={12} md={8} lg={6}>
              <Tooltip title="新用户中曾完成 tutorial_completed 的比例（全生命周期）">
                <Statistic
                  title="新用户教程完成率"
                  value={formatPercent(kpi?.new_user_tutorial_complete_rate)}
                  valueStyle={{ color: '#1677ff', fontWeight: 700 }}
                />
              </Tooltip>
            </Col>
            <Col xs={12} md={8} lg={6}>
              <Statistic
                title="完成教程"
                value={formatInt(kpi?.new_user_tutorial_completed_users)}
                suffix="人"
              />
            </Col>
          </Row>
        </Card>

        <Card
          type="inner"
          title="新户核心数据"
          extra={<Text type="secondary">固定近 7 天，不受上方时间窗口影响</Text>}
        >
          {tutorialDailyMissing || coreDailyStale ? (
            <Empty description="接口仍为旧版本（缺少引导/首单/看广告曲线），请执行 npm run restart 后刷新" />
          ) : tutorialDaily.some((p) => p.new_users > 0) ? (
            <ReactECharts option={tutorialDailyOption} style={{ height: 340 }} />
          ) : (
            <Empty description="近 7 天暂无新用户数据" />
          )}
        </Card>

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

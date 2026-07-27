import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Col, Empty, Row, Space, Statistic, Table, Tag, Tooltip, Typography, message } from 'antd';
import ReactECharts from '../components/AnalyticsChart';

import { appendPlatformQuery } from '../../shared/platforms';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { buildWindowQuery, type WindowValue } from '../timeWindow';

import {
  CHART_GRID_WITH_ZOOM,
  CHART_LEGEND_TOP,
  bucketShort,
  defaultZoomStart,
  formatInt,
  formatPercent,
  makeDataZoom,
} from './utils';

const { Text } = Typography;

interface EngagementSeriesPoint {
  bucket: string;
  ts: number;
  daily_quest_cnt: number;
  weekly_milestone_cnt: number;
  checkin_cnt: number;
  fountain_draw_cnt: number;
  affinity_card_cnt: number;
  merge_success_cnt_estimated: number;
}

interface EngagementTopRow {
  key: string;
  cnt: number;
}

interface EngagementKpi {
  daily_quest_claim_cnt: number;
  daily_quest_users: number;
  weekly_milestone_cnt: number;
  weekly_milestone_users: number;
  checkin_users: number;
  fountain_draw_cnt: number;
  fountain_draw_users: number;
  affinity_drop_users: number;
  affinity_card_total: number;
  affinity_duplicate_rate: number | null;
  merge_success_estimated: number;
  collection_discover_cnt: number;
  computed_at: number;
}

interface EngagementResponse {
  ok: boolean;
  query?: { game_key: string; from: string; to: string; window_minutes: number };
  kpi?: EngagementKpi;
  series?: EngagementSeriesPoint[];
  top_daily_quests?: EngagementTopRow[];
  fountain_draw_breakdown?: EngagementTopRow[];
  code?: string;
  error?: string;
}

const DRAW_KIND_LABELS: Record<string, string> = {
  single: '单抽',
  multi: '十连',
  multi_free: '广告免费十连',
};

/**
 * 玩法参与度（任务/签到/抽奖/熟客/合成/图鉴）。
 *
 * 关注点：
 *   - 各留存玩法的人均触发频次：判断哪些功能"挂着没人玩"
 *   - 抽奖结构：单抽 vs 十连 vs 广告免费的分布
 *   - 熟客卡重复率：>70% 时基本说明老用户卡池快刷光，需要扩 SSR 池
 *   - 合成次数（merge_success 事件 SDK 10% 采样，已 ×10 折算）
 *
 * 数据源：/api/realtime/huahua-engagement
 */
export function EngagementPanel() {
  const { gameKey, platform, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<EngagementResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (nextGameKey: string, nextWindow: WindowValue) => {
      const seq = ++requestSeqRef.current;
      try {
        const queryStr = appendPlatformQuery(buildWindowQuery(nextWindow), platform);
        const res = await fetch(
          `/api/realtime/huahua-engagement?game=${encodeURIComponent(nextGameKey)}&${queryStr}`,
        );
        const json = (await res.json()) as EngagementResponse;
        if (seq !== requestSeqRef.current) return;
        if (!json.ok) {
          message.error(`获取参与度数据失败：${json.error || json.code}`);
        }
        setData(json);
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        message.error(`加载参与度数据失败：${String(error)}`);
      }
    },
    [platform, setLastRefreshedAt],
  );

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, platform, windowSel, refreshToken, load]);

  const kpi = data?.kpi;
  const series = data?.series || [];
  const topQuests = data?.top_daily_quests || [];
  const drawBreakdown = data?.fountain_draw_breakdown || [];

  const seriesOption = useMemo(() => {
    const xAxis = series.map((p) => bucketShort(p.bucket));
    const zoomStart = defaultZoomStart(series.length);
    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['日常任务', '周里程碑', '签到', '许愿喷泉', '熟客卡掉落', '合成（×10 估算）'],
        type: 'scroll',
        ...CHART_LEGEND_TOP,
      },
      grid: CHART_GRID_WITH_ZOOM,
      xAxis: { type: 'category', data: xAxis, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', name: '次数', minInterval: 1 },
      dataZoom: makeDataZoom(zoomStart, 100),
      series: [
        {
          name: '日常任务',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#059669' },
          data: series.map((p) => p.daily_quest_cnt),
        },
        {
          name: '周里程碑',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#10b981' },
          data: series.map((p) => p.weekly_milestone_cnt),
        },
        {
          name: '签到',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#2563eb' },
          data: series.map((p) => p.checkin_cnt),
        },
        {
          name: '许愿喷泉',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#7c3aed' },
          data: series.map((p) => p.fountain_draw_cnt),
        },
        {
          name: '熟客卡掉落',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#d97706' },
          data: series.map((p) => p.affinity_card_cnt),
        },
        {
          name: '合成（×10 估算）',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#94a3b8' },
          data: series.map((p) => p.merge_success_cnt_estimated),
        },
      ],
    };
  }, [series]);

  const drawOption = useMemo(() => {
    if (drawBreakdown.length === 0) return null;
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} 次 ({d}%)' },
      legend: { bottom: 0, textStyle: { color: '#475569' } },
      series: [
        {
          type: 'pie',
          radius: ['40%', '70%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
          label: { show: true, formatter: '{b}\n{c}' },
          data: drawBreakdown.map((d) => ({
            name: DRAW_KIND_LABELS[d.key] || d.key,
            value: d.cnt,
          })),
        },
      ],
    };
  }, [drawBreakdown]);

  const questColumns = [
    { title: '任务模板', dataIndex: 'key', key: 'key' },
    {
      title: '领奖次数',
      dataIndex: 'cnt',
      key: 'cnt',
      align: 'right' as const,
      render: (v: number) => formatInt(v),
    },
  ];

  return (
    <Card
      title={
        <Tooltip title="数据源：daily_quest_claim / weekly_milestone_claim / checkin_sign / fountain_draw / affinity_card_drop / merge_success / collection_discover">
          <span style={{ cursor: 'help' }}>玩法参与度</span>
        </Tooltip>
      }
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="窗口内 daily_quest_claim 触发用户数">
                <Statistic
                  title="日常任务用户"
                  value={formatInt(kpi?.daily_quest_users)}
                  suffix="人"
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="日常领奖次数"
                value={formatInt(kpi?.daily_quest_claim_cnt)}
                suffix="次"
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="周里程碑领奖"
                value={formatInt(kpi?.weekly_milestone_cnt)}
                suffix="次"
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="窗口内 checkin_sign 触发用户数">
                <Statistic title="签到用户" value={formatInt(kpi?.checkin_users)} suffix="人" />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="许愿喷泉抽奖"
                value={formatInt(kpi?.fountain_draw_cnt)}
                suffix="次"
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="抽奖用户"
                value={formatInt(kpi?.fountain_draw_users)}
                suffix="人"
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="熟客卡总掉落张数（含重复）">
                <Statistic
                  title="熟客卡掉落"
                  value={formatInt(kpi?.affinity_card_total)}
                  suffix="张"
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="重复 / 总掉落。> 70% 提示老用户卡池接近满收，需扩 SSR 池">
                <Statistic
                  title="熟客卡重复率"
                  value={formatPercent(kpi?.affinity_duplicate_rate)}
                  valueStyle={{
                    color:
                      (kpi?.affinity_duplicate_rate ?? 0) > 0.7 ? '#e11d48' : undefined,
                  }}
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="merge_success 事件 SDK 10% 采样，已 ×10 折算">
                <Statistic
                  title="合成估算"
                  value={formatInt(kpi?.merge_success_estimated)}
                  suffix="次"
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="图鉴新发现"
                value={formatInt(kpi?.collection_discover_cnt)}
                suffix="条"
              />
            </Card>
          </Col>
        </Row>

        <Card type="inner" title="参与度时间序列（5 分钟桶）">
          {series.length > 0 ? (
            <ReactECharts option={seriesOption} style={{ height: 360 }} />
          ) : (
            <Empty description="窗口内还没有参与度事件" />
          )}
        </Card>

        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Card type="inner" title="许愿喷泉抽奖结构">
              {drawOption ? (
                <ReactECharts option={drawOption} style={{ height: 280 }} />
              ) : (
                <Empty description="窗口内还没有抽奖事件" />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card
              type="inner"
              title={
                <Space size={8}>
                  <span>Top 10 日常任务模板</span>
                  <Tag color="blue">按领奖次数排序</Tag>
                </Space>
              }
            >
              <Table
                size="small"
                dataSource={topQuests}
                rowKey="key"
                pagination={false}
                columns={questColumns}
                locale={{ emptyText: '暂无任务领奖数据' }}
              />
            </Card>
          </Col>
        </Row>
      </Space>
    </Card>
  );
}

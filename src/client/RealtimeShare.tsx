import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Col, Empty, Row, Space, Statistic, Table, Tag, Tooltip, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';

import { type WindowValue, buildWindowQuery } from './timeWindow';

const { Text } = Typography;

interface ShareKpi {
  game_key: string;
  from: string;
  to: string;
  share_count: number;
  share_users: number;
  dau: number;
  share_penetration_rate: number;
  share_per_user: number;
}

interface ShareSeriesPoint {
  hour: string;
  share_count: number;
  share_users: number;
}

interface ShareEntryBreakdown {
  entry_point: string;
  share_count: number;
  share_users: number;
  latest_title: string;
}

interface ShareResponse {
  ok: true;
  query: { game_key: string; from: string; to: string; window_minutes: number };
  kpi: ShareKpi;
  series_hourly: ShareSeriesPoint[];
  breakdown_by_entry: ShareEntryBreakdown[];
}

interface RealtimeShareProps {
  fixedGameKey: string;
  windowSel: WindowValue;
  refreshToken: number;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '0';
}

function formatHourLabel(hour: string): string {
  if (!hour) return '';
  const utcDate = new Date(`${hour}:00.000Z`);
  if (Number.isNaN(utcDate.getTime())) return hour;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(utcDate.getMonth() + 1)}-${pad(utcDate.getDate())} ${pad(utcDate.getHours())}:00`;
}

/**
 * 通用分享入口（所有接入 @gp/analytics-sdk 的游戏都会上报）：
 *   - wx_button / wx_menu / wx_other 来自微信小游戏 onShareAppMessage 的 from 字段
 *     （button=页面分享按钮，menu=右上角菜单，其它=兜底）
 *   - api_share_game 是业务侧主动调 wx.shareAppMessage 触发的分享
 */
const COMMON_ENTRY_LABELS: Record<string, string> = {
  api_share_game: '业务主动分享接口',
  wx_button: '微信原生分享按钮',
  wx_menu: '微信右上角菜单转发',
  wx_other: '微信其它来源分享',
  unknown: '未知入口',
};

/**
 * 游戏专属分享入口语义：当某款游戏在通用入口之外又上报了业务化的入口名时，
 * 在这里按 gameKey 单独标注，命中时优先于通用层的中文说明。
 */
const GAME_ENTRY_LABELS: Record<string, Record<string, string>> = {
  hotpot: {
    // BowlLevelClearOverlay 通关弹窗的「分享炫耀」按钮，比通用层的描述更精准
    api_share_game: '通关炫耀分享',
    // BowlBadgeUnlockOverlay 解锁徽章成就后的「分享送 remove 道具」奖励入口
    badge_unlock_reward: '徽章解锁分享送道具',
  },
};

function getEntryLabel(gameKey: string, entryPoint: string): string {
  return (
    GAME_ENTRY_LABELS[gameKey]?.[entryPoint] ?? COMMON_ENTRY_LABELS[entryPoint] ?? '-'
  );
}

export function RealtimeShare(props: RealtimeShareProps): ReactElement {
  const { fixedGameKey: gameKey, windowSel, refreshToken } = props;
  const [data, setData] = useState<ShareResponse | null>(null);

  const loadData = useCallback(async () => {
    const queryStr = buildWindowQuery(windowSel);
    const url = `/api/realtime/share?game=${encodeURIComponent(gameKey)}&${queryStr}`;
    const res = await fetch(url);
    const json = (await res.json()) as ShareResponse | { ok: false };
    if ('ok' in json && json.ok) {
      setData(json);
    }
  }, [gameKey, windowSel]);

  useEffect(() => {
    void loadData();
  }, [loadData, refreshToken]);

  const chartOption = useMemo(() => {
    const series = data?.series_hourly || [];
    const xLabels = series.map((item) => formatHourLabel(item.hour));
    return {
      tooltip: { trigger: 'axis' as const },
      legend: {
        data: ['分享次数', '分享人数'],
        top: 6,
        textStyle: { fontSize: 13, color: '#262626', fontWeight: 500 },
      },
      grid: { left: 56, right: 40, top: 52, bottom: 58 },
      dataZoom: series.length > 48
        ? [
          { type: 'inside' as const, start: Math.max(0, 100 - (48 / series.length) * 100), end: 100 },
          { type: 'slider' as const, height: 18, bottom: 12, start: Math.max(0, 100 - (48 / series.length) * 100), end: 100 },
        ]
        : [],
      xAxis: {
        type: 'category' as const,
        data: xLabels,
        axisLabel: { hideOverlap: true, fontSize: 11 },
      },
      yAxis: { type: 'value' as const, name: '次数 / 人数', minInterval: 1 },
      series: [
        {
          name: '分享次数',
          type: 'bar' as const,
          barMaxWidth: 22,
          itemStyle: { color: '#722ED1', borderRadius: [3, 3, 0, 0] },
          data: series.map((item) => item.share_count),
        },
        {
          name: '分享人数',
          type: 'line' as const,
          smooth: true,
          symbol: 'circle' as const,
          symbolSize: 6,
          lineStyle: { width: 2.5, color: '#13C2C2' },
          itemStyle: { color: '#13C2C2' },
          data: series.map((item) => item.share_users),
        },
      ],
    };
  }, [data]);

  const columns = [
    { title: '入口', dataIndex: 'entry_point', key: 'entry_point' },
    {
      title: '入口说明',
      dataIndex: 'entry_point',
      key: 'entry_label',
      render: (v: string) => {
        const label = getEntryLabel(gameKey, v);
        return label === '-' ? <Text type="secondary">-</Text> : label;
      },
    },
    {
      title: '分享次数',
      dataIndex: 'share_count',
      key: 'share_count',
      render: (v: number) => formatNumber(v),
    },
    {
      title: '分享人数',
      dataIndex: 'share_users',
      key: 'share_users',
      render: (v: number) => formatNumber(v),
    },
    {
      title: '最近标题',
      dataIndex: 'latest_title',
      key: 'latest_title',
      render: (v: string) => v || <Text type="secondary">-</Text>,
    },
  ];

  return (
    <Card
      size="small"
      title={(
        <Space>
          <span>分享传播</span>
          <Tag color="cyan">通用</Tag>
          <Tag color="blue">发起分享</Tag>
        </Space>
      )}
      extra={(
        <Tooltip title="当前只统计 share_app_message 发起分享事件，不代表真实分享成功或带来回流；回流需要后续接 share_open / invite_accept 等事件。">
          <Tag style={{ cursor: 'help' }}>口径说明 ⓘ</Tag>
        </Tooltip>
      )}
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Tooltip title="窗口内 share_app_message 事件总数">
              <Statistic title="分享次数" value={data?.kpi.share_count ?? 0} suffix="次" />
            </Tooltip>
          </Col>
          <Col xs={12} md={6}>
            <Tooltip title="窗口内发起过分享的去重用户数">
              <Statistic title="分享人数" value={data?.kpi.share_users ?? 0} suffix="人" />
            </Tooltip>
          </Col>
          <Col xs={12} md={6}>
            <Tooltip title="分享人数 / DAU，反映多少活跃玩家愿意触发分享">
              <Statistic title="分享渗透率(%)" value={data?.kpi.share_penetration_rate ?? 0} precision={2} />
            </Tooltip>
          </Col>
          <Col xs={12} md={6}>
            <Tooltip title="分享次数 / 分享人数，反映触发分享的玩家平均分享几次">
              <Statistic title="人均分享次数" value={data?.kpi.share_per_user ?? 0} precision={2} suffix="次/人" />
            </Tooltip>
          </Col>
        </Row>

        <Card type="inner" title="分享趋势（1 小时桶）">
          {data && data.series_hourly.some((item) => item.share_count > 0) ? (
            <ReactECharts option={chartOption} style={{ height: 280 }} notMerge lazyUpdate />
          ) : (
            <Empty description="当前窗口暂无分享事件" />
          )}
        </Card>

        <Card type="inner" title="按分享入口拆分">
          {data && data.breakdown_by_entry.length > 0 ? (
            <Table
              size="small"
              rowKey="entry_point"
              columns={columns}
              dataSource={data.breakdown_by_entry}
              pagination={false}
            />
          ) : (
            <Empty description="暂无分享入口数据" />
          )}
        </Card>
      </Space>
    </Card>
  );
}

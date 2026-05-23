import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Col, Empty, Row, Space, Statistic, Table, Typography, message } from 'antd';

import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { buildWindowQuery, type WindowValue } from '../timeWindow';

const { Text } = Typography;

interface CaizhuGameplayResponse {
  ok: boolean;
  kpi?: {
    mode_enter_users: number;
    classic_start_count: number;
    classic_end_count: number;
    classic_users: number;
    avg_classic_score: number;
    avg_classic_duration_ms: number;
    level_select_count: number;
    prop_request_count: number;
    prop_use_count: number;
    tutorial_step_count: number;
  };
  mode_entries?: Array<{ mode: string; count: number; users: number }>;
  prop_usage?: Array<{ prop_type: string; requests: number; uses: number; use_rate: number | null }>;
  tutorial_steps?: Array<{ step_id: string; done: number; skip: number }>;
  code?: string;
  error?: string;
}

const MODE_LABELS: Record<string, string> = {
  level: '闯关模式',
  classic: '经典模式',
  rank: '排行榜',
  skin: '皮肤页',
  settings: '设置',
  game_club: '游戏圈',
};

const PROP_LABELS: Record<string, string> = {
  colorBlast: '同色爆破',
  crossClear: '十字清场',
  wildNext: '万能预备',
};

function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (!ms) return '-';
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function CaizhuGameplayPanel() {
  const { gameKey, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<CaizhuGameplayResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async (nextGameKey: string, nextWindow: WindowValue) => {
    const seq = ++requestSeqRef.current;
    try {
      const res = await fetch(`/api/realtime/caizhu-gameplay?game=${encodeURIComponent(nextGameKey)}&${buildWindowQuery(nextWindow)}`);
      const json = (await res.json()) as CaizhuGameplayResponse;
      if (seq !== requestSeqRef.current) return;
      if (!json.ok) message.error(`获取彩珠玩法数据失败: ${json.error || json.code}`);
      setData(json);
      setLastRefreshedAt(Date.now());
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      message.error(`加载彩珠玩法数据失败: ${String(error)}`);
    }
  }, [setLastRefreshedAt]);

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, windowSel, refreshToken, load]);

  const kpi = data?.kpi;

  return (
    <Card title="彩珠五连玩法总览">
      {kpi ? (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}><Card size="small"><Statistic title="入口去重用户" value={kpi.mode_enter_users} suffix="人" /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="经典开始" value={kpi.classic_start_count} suffix="局" /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="经典结束" value={kpi.classic_end_count} suffix="局" /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="经典玩家" value={kpi.classic_users} suffix="人" /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="经典平均分" value={kpi.avg_classic_score.toFixed(0)} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="经典平均时长" value={formatDuration(kpi.avg_classic_duration_ms)} /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="关卡选择" value={kpi.level_select_count} suffix="次" /></Card></Col>
            <Col xs={12} md={6}><Card size="small"><Statistic title="道具使用率" value={pct(kpi.prop_request_count ? kpi.prop_use_count / kpi.prop_request_count : null)} /></Card></Col>
          </Row>

          <Text type="secondary">入口、经典模式、闯关关卡、道具和教程事件均来自 @gp/analytics-sdk 标准事件流。</Text>

          <Row gutter={[16, 16]}>
            <Col xs={24} lg={8}>
              <Table
                size="small"
                rowKey="mode"
                title={() => '入口分布'}
                dataSource={data.mode_entries || []}
                columns={[
                  { title: '入口', dataIndex: 'mode', render: (v: string) => MODE_LABELS[v] || v },
                  { title: '次数', dataIndex: 'count', align: 'right' },
                  { title: '用户', dataIndex: 'users', align: 'right' },
                ]}
                pagination={false}
              />
            </Col>
            <Col xs={24} lg={8}>
              <Table
                size="small"
                rowKey="prop_type"
                title={() => '道具转化'}
                dataSource={data.prop_usage || []}
                columns={[
                  { title: '道具', dataIndex: 'prop_type', render: (v: string) => PROP_LABELS[v] || v },
                  { title: '请求', dataIndex: 'requests', align: 'right' },
                  { title: '使用', dataIndex: 'uses', align: 'right' },
                  { title: '使用率', dataIndex: 'use_rate', align: 'right', render: pct },
                ]}
                pagination={false}
              />
            </Col>
            <Col xs={24} lg={8}>
              <Table
                size="small"
                rowKey="step_id"
                title={() => '新手教程步骤'}
                dataSource={data.tutorial_steps || []}
                columns={[
                  { title: '步骤', dataIndex: 'step_id' },
                  { title: '完成', dataIndex: 'done', align: 'right' },
                  { title: '跳过', dataIndex: 'skip', align: 'right' },
                ]}
                pagination={false}
              />
            </Col>
          </Row>
        </Space>
      ) : (
        <Empty description="暂无彩珠玩法事件，请先打开游戏产生数据" />
      )}
    </Card>
  );
}

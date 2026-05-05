import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Empty, Layout, Row, Select, Space, Statistic, Table, Tabs, Tag, Tooltip, Typography, message } from 'antd';
import ReactECharts from 'echarts-for-react';

import type { DashboardData, MetricCatalogItem, PlayerFacts } from '../shared/types';
import { GAME_CONFIGS, getGameConfig } from '../shared/game-config';

const { Header, Content } = Layout;
const { Title, Text } = Typography;

const emptyData: DashboardData = {
  summary: {
    latestDate: '',
    latestHour: '',
    usersTotal: 0,
    activeUsers: 0,
    inferredActiveUsersToday: 0,
    avgLevel: 0,
    avgDiamond: 0,
    totalMergeCount: 0,
    totalDeliveredOrders: 0,
  },
  dailyMetrics: [],
  hourlyMetrics: [],
  levelBuckets: [],
  recentPlayers: [],
  metricCatalog: [],
  modules: [],
  quality: {
    storageMode: 'sqlite',
    lastIngestAt: 0,
    nextIngestAt: 0,
    snapshotCount: 0,
    historyCount: 0,
    changedSnapshotCount: 0,
    parseFailedCount: 0,
  },
  gameSpecific: {},
};

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '0';
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('zh-CN');
}

function formatHourLabel(hourKey: string): string {
  if (!hourKey) return '-';
  const [date, hour] = hourKey.split('T');
  if (!date || !hour) return hourKey;
  const [, month, day] = date.split('-');
  return `${month}-${day} ${hour}:00`;
}

function precisionColor(item: MetricCatalogItem): string {
  if (item.precision === 'exact') return 'green';
  if (item.precision === 'inferred') return 'orange';
  return 'default';
}

export function App() {
  const [gameKey, setGameKey] = useState('huahua');
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(0);
  const gameConfig = getGameConfig(gameKey);

  async function loadDashboard(nextGameKey = gameKey) {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard?game=${encodeURIComponent(nextGameKey)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setLastRefreshedAt(Date.now());
    } catch (error) {
      message.error(`加载看板失败: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function recomputeMetrics() {
    setLoading(true);
    try {
      const res = await fetch('/api/metrics/recompute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ game: gameKey }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadDashboard();
      message.success('指标已重算');
    } catch (error) {
      message.error(`重算失败: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function ingestLatestCloudbaseData() {
    setIngesting(true);
    try {
      const res = await fetch('/api/ingest/cloudbase', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          game: gameKey,
          collection: gameConfig.collectionName,
          limit: 100,
        }),
      });
      const result = await res.json();
      if (!res.ok || result.ok !== true) {
        throw new Error(result?.message || result?.error || `HTTP ${res.status}`);
      }
      await loadDashboard();
      message.success(`已同步 ${result.imported} 名玩家数据，指标天数 ${result.metricDays}`);
    } catch (error) {
      message.error(`拉取线上数据失败: ${String(error)}`);
    } finally {
      setIngesting(false);
    }
  }

  useEffect(() => {
    void loadDashboard('huahua');
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadDashboard(gameKey);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [gameKey]);

  const trendOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    legend: { data: ['快照活跃玩家', '平均等级', '广告权益使用'] },
    xAxis: { type: 'category', data: data.dailyMetrics.map((item) => item.metricDate) },
    yAxis: [{ type: 'value' }],
    series: [
      {
        name: '快照活跃玩家',
        type: 'line',
        smooth: true,
        data: data.dailyMetrics.map((item) => item.activeUsers),
      },
      {
        name: '平均等级',
        type: 'line',
        smooth: true,
        data: data.dailyMetrics.map((item) => Number(item.avgLevel.toFixed(2))),
      },
      {
        name: '广告权益使用',
        type: 'bar',
        data: data.dailyMetrics.map((item) => item.totalAdEntitlementUsed),
      },
    ],
  }), [data.dailyMetrics]);

  const hourlyOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    legend: { data: ['实时活跃用户', '新增玩家', '合成增量', '订单增量', '首次订单玩家'] },
    xAxis: { type: 'category', data: data.hourlyMetrics.map((item) => formatHourLabel(item.metricHour)) },
    yAxis: [{ type: 'value' }],
    series: [
      {
        name: '实时活跃用户',
        type: 'line',
        smooth: true,
        areaStyle: {},
        data: data.hourlyMetrics.map((item) => item.inferredActiveUsers),
      },
      {
        name: '新增玩家',
        type: 'line',
        smooth: true,
        symbolSize: 8,
        data: data.hourlyMetrics.map((item) => item.newUsers),
      },
      {
        name: '合成增量',
        type: 'line',
        smooth: true,
        data: data.hourlyMetrics.map((item) => item.mergeDelta),
      },
      {
        name: '订单增量',
        type: 'line',
        smooth: true,
        data: data.hourlyMetrics.map((item) => item.orderDelta),
      },
      {
        name: '首次订单玩家',
        type: 'line',
        smooth: true,
        symbolSize: 8,
        data: data.hourlyMetrics.map((item) => item.firstOrderUsers),
      },
    ],
  }), [data.hourlyMetrics]);

  const levelOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: data.levelBuckets.map((item) => `Lv.${item.level}`) },
    yAxis: { type: 'value' },
    series: [
      {
        name: '玩家数',
        type: 'bar',
        data: data.levelBuckets.map((item) => item.users),
      },
    ],
  }), [data.levelBuckets]);

  const columnMap = useMemo<Record<string, any>>(() => ({
    userId: {
      title: '用户 ID',
      dataIndex: 'userId',
      width: 280,
      sorter: (a: PlayerFacts, b: PlayerFacts) => a.userId.localeCompare(b.userId),
      render: (value: string) => <Text code copyable>{value}</Text>,
    },
    platform: {
      title: '平台',
      dataIndex: 'platform',
      width: 90,
      sorter: (a: PlayerFacts, b: PlayerFacts) => a.platform.localeCompare(b.platform),
    },
    activeDate: {
      title: '活跃日期',
      dataIndex: 'activeDate',
      width: 120,
      sorter: (a: PlayerFacts, b: PlayerFacts) => a.activeDate.localeCompare(b.activeDate),
      defaultSortOrder: 'descend' as const,
    },
    level: {
      title: <Tooltip title="来自存档快照中的玩家等级字段。">等级</Tooltip>,
      dataIndex: 'level',
      width: 90,
      sorter: (a: PlayerFacts, b: PlayerFacts) => a.level - b.level,
    },
    diamond: {
      title: <Tooltip title="来自存档快照中的钻石余额，表示当前余额，不是收入流水。">钻石</Tooltip>,
      dataIndex: 'diamond',
      width: 100,
      sorter: (a: PlayerFacts, b: PlayerFacts) => a.diamond - b.diamond,
      render: formatNumber,
    },
    mergeCountTotal: {
      title: <Tooltip title="来自 huahua_merge_stats.totalMerges。">累计合成</Tooltip>,
      dataIndex: 'mergeCountTotal',
      width: 120,
      sorter: (a: PlayerFacts, b: PlayerFacts) => a.mergeCountTotal - b.mergeCountTotal,
      render: formatNumber,
    },
    deliveredOrdersTotal: {
      title: <Tooltip title="来自 huahua_merge_stats.totalOrders，表示累计交付订单。">累计订单</Tooltip>,
      dataIndex: 'deliveredOrdersTotal',
      width: 120,
      sorter: (a: PlayerFacts, b: PlayerFacts) => a.deliveredOrdersTotal - b.deliveredOrdersTotal,
      render: formatNumber,
    },
    adEntitlementUsedToday: {
      title: (
        <Tooltip title="来自 huahua_ad_entitlements：把 used / dailyUsed 里的各权益当日已用次数求和。它表示广告权益消耗，不等于全量广告展示或广告完成次数。">
          广告权益使用
        </Tooltip>
      ),
      dataIndex: 'adEntitlementUsedToday',
      width: 140,
      sorter: (a: PlayerFacts, b: PlayerFacts) => a.adEntitlementUsedToday - b.adEntitlementUsedToday,
      render: formatNumber,
    },
    checkinTotalDays: {
      title: '签到天数',
      dataIndex: 'checkinTotalDays',
      width: 110,
      sorter: (a: PlayerFacts, b: PlayerFacts) => a.checkinTotalDays - b.checkinTotalDays,
    },
    questWeeklyPoints: {
      title: '周积分',
      dataIndex: 'questWeeklyPoints',
      width: 100,
      sorter: (a: PlayerFacts, b: PlayerFacts) => a.questWeeklyPoints - b.questWeeklyPoints,
    },
  }), []);

  const columns = useMemo(
    () => gameConfig.playerColumns.map((key) => columnMap[key]).filter(Boolean),
    [columnMap, gameConfig.playerColumns],
  );

  const metricTags = (
    <Space wrap>
      {data.metricCatalog.map((item) => (
        <Tooltip key={item.key} title={item.description}>
          <Tag color={precisionColor(item)}>{item.name}</Tag>
        </Tooltip>
      ))}
    </Space>
  );

  const commonDashboard = (
    <>
      <Alert
        className="metric-note"
        type="info"
        showIcon
        message={`当前游戏：${gameConfig.displayName}，数据前缀：${gameConfig.payloadPrefix}，集合：${gameConfig.collectionName}`}
        description="活跃趋势优先使用定时快照变化推导；若玩家打开游戏但没有触发云保存，仍可能无法感知。真实 DAU 需要后续接入登录或启动事件。"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8} lg={4}>
          <Card><Statistic title="玩家总量" value={data.summary.usersTotal} /></Card>
        </Col>
        <Col xs={24} md={8} lg={4}>
          <Card>
            <Statistic title="快照推导活跃" value={data.summary.inferredActiveUsersToday} />
            <Text type="secondary">{data.summary.latestDate || '-'}</Text>
          </Card>
        </Col>
        <Col xs={24} md={8} lg={4}>
          <Card><Statistic title="平均等级" value={data.summary.avgLevel} precision={1} /></Card>
        </Col>
        <Col xs={24} md={8} lg={4}>
          <Card><Statistic title="平均钻石" value={data.summary.avgDiamond} precision={1} /></Card>
        </Col>
        <Col xs={24} md={8} lg={4}>
          <Card><Statistic title="累计合成" value={data.summary.totalMergeCount} /></Card>
        </Col>
        <Col xs={24} md={8} lg={4}>
          <Card><Statistic title="累计订单" value={data.summary.totalDeliveredOrders} /></Card>
        </Col>
      </Row>
      <Row gutter={[16, 16]} className="chart-row">
        <Col xs={24} xl={14}>
          <Card title="日趋势概览" extra={<Tooltip title="日活跃为快照变化推导，不是启动 DAU。">口径说明</Tooltip>}>
            {data.dailyMetrics.length > 0 ? <ReactECharts option={trendOption} /> : <Empty description="暂无指标数据" />}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="等级分布">
            {data.levelBuckets.length > 0 ? <ReactECharts option={levelOption} /> : <Empty description="暂无等级数据" />}
          </Card>
        </Col>
      </Row>
    </>
  );

  const huahua = data.gameSpecific.huahua;
  const gameSpecificDashboard = (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card title="合成经营">
          <Row gutter={16}>
            <Col span={12}><Statistic title="累计合成" value={huahua?.totalMerges || 0} /></Col>
            <Col span={12}><Statistic title="今日合成" value={huahua?.todayMerges || 0} /></Col>
          </Row>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card title="订单经营">
          <Row gutter={16}>
            <Col span={8}><Statistic title="累计订单" value={huahua?.totalOrders || 0} /></Col>
            <Col span={8}><Statistic title="今日订单" value={huahua?.todayOrders || 0} /></Col>
            <Col span={8}><Statistic title="订单玩家" value={huahua?.playersWithOrders || 0} /></Col>
          </Row>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card title="签到任务">
          <Row gutter={16}>
            <Col span={12}><Statistic title="累计签到天数" value={huahua?.totalCheckinDays || 0} /></Col>
            <Col span={12}><Statistic title="任务周积分" value={huahua?.totalQuestWeeklyPoints || 0} /></Col>
          </Row>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card title="活动收集与广告权益">
          <Row gutter={16}>
            <Col span={12}><Statistic title="活动积分" value={huahua?.totalEventPoints || 0} /></Col>
            <Col span={12}><Statistic title="广告权益使用" value={huahua?.totalAdEntitlementUsed || 0} /></Col>
          </Row>
        </Card>
      </Col>
    </Row>
  );

  const playerDetail = (
    <Card title="玩家快照明细" className="table-card">
      <Table<PlayerFacts>
        rowKey="userId"
        loading={loading}
        dataSource={data.recentPlayers}
        columns={columns}
        locale={{ emptyText: <Empty description="暂无玩家数据" /> }}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        scroll={{ x: 1300 }}
      />
    </Card>
  );

  const trendDashboard = (
    <>
      <Alert
        className="metric-note"
        type="info"
        showIcon
        message="实时趋势用于观察投流后玩家活跃变化"
        description="当前按小时统计活跃用户。由于游戏尚未接入启动事件，活跃来自玩家云存档更新推导；后续接入登录/启动事件后可升级为标准实时 DAU/在线趋势。"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic
              title="最近小时活跃"
              value={data.hourlyMetrics.at(-1)?.inferredActiveUsers || 0}
              suffix="人"
            />
            <Text type="secondary">{formatHourLabel(data.summary.latestHour)}</Text>
          </Card>
        </Col>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic title="今日活跃" value={data.summary.inferredActiveUsersToday} suffix="人" />
            <Text type="secondary">{data.summary.latestDate || '-'}</Text>
          </Card>
        </Col>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic title="最近小时新增" value={data.hourlyMetrics.at(-1)?.newUsers || 0} suffix="人" />
          </Card>
        </Col>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic title="合成增量" value={data.hourlyMetrics.at(-1)?.mergeDelta || 0} suffix="次" />
          </Card>
        </Col>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic title="订单增量" value={data.hourlyMetrics.at(-1)?.orderDelta || 0} suffix="单" />
          </Card>
        </Col>
        <Col xs={24} md={8} xl={4}>
          <Card>
            <Statistic title="首次订单玩家" value={data.hourlyMetrics.at(-1)?.firstOrderUsers || 0} suffix="人" />
          </Card>
        </Col>
        <Col span={24}>
          <Card title="实时活跃趋势" extra={<Tooltip title="小时级活跃用户，当前由云存档更新推导。">口径说明</Tooltip>}>
            {data.hourlyMetrics.length > 0 ? <ReactECharts option={hourlyOption} /> : <Empty description="暂无实时趋势，下一次数据同步后会生成" />}
          </Card>
        </Col>
      </Row>
    </>
  );

  const qualityDashboard = (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={12}>
        <Card title="数据质量">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="存储模式">{data.quality.storageMode}</Descriptions.Item>
            <Descriptions.Item label="最后拉取">{formatTime(data.quality.lastIngestAt)}</Descriptions.Item>
            <Descriptions.Item label="玩家快照数">{data.quality.snapshotCount}</Descriptions.Item>
            <Descriptions.Item label="小时趋势样本">{data.quality.historyCount}</Descriptions.Item>
            <Descriptions.Item label="活跃样本玩家">{data.quality.changedSnapshotCount}</Descriptions.Item>
            <Descriptions.Item label="解析失败数">{data.quality.parseFailedCount}</Descriptions.Item>
          </Descriptions>
        </Card>
      </Col>
      <Col xs={24} lg={12}>
        <Card title="最近拉取任务">
          {data.quality.latestRun ? (
            <Descriptions column={1} size="small">
              <Descriptions.Item label="状态">{data.quality.latestRun.status}</Descriptions.Item>
              <Descriptions.Item label="集合">{data.quality.latestRun.collectionName}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{formatTime(data.quality.latestRun.startedAt)}</Descriptions.Item>
              <Descriptions.Item label="结束时间">{formatTime(data.quality.latestRun.finishedAt)}</Descriptions.Item>
              <Descriptions.Item label="拉取数量">{data.quality.latestRun.fetchedCount}</Descriptions.Item>
              <Descriptions.Item label="活跃样本">{data.quality.latestRun.changedCount}</Descriptions.Item>
              <Descriptions.Item label="未更新玩家">{data.quality.latestRun.unchangedCount}</Descriptions.Item>
            </Descriptions>
          ) : <Empty description="暂无拉取记录" />}
        </Card>
      </Col>
      <Col span={24}>
        <Card title="指标目录">{metricTags}</Card>
      </Col>
    </Row>
  );

  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div>
          <Title level={3} className="app-title">游戏经营分析</Title>
          <Text type="secondary">本地内部看板，当前数据来自 CloudBase 存档快照解析</Text>
        </div>
        <Space>
          <Select
            value={gameKey}
            onChange={(value) => {
              setGameKey(value);
              void loadDashboard(value);
            }}
            className="game-input"
            options={GAME_CONFIGS.map((item) => ({
              value: item.gameKey,
              label: `${item.displayName}（${item.payloadPrefix}）`,
            }))}
          />
          <Button onClick={() => void loadDashboard()} loading={loading}>刷新</Button>
          <Text type="secondary">自动刷新：60秒 / {formatTime(lastRefreshedAt)}</Text>
          <Button onClick={() => void ingestLatestCloudbaseData()} loading={ingesting}>
            拉取线上最新数据
          </Button>
          <Button type="primary" onClick={() => void recomputeMetrics()} loading={loading}>重算指标</Button>
        </Space>
      </Header>

      <Content className="app-content">
        <Tabs
          items={[
            { key: 'trend', label: '实时趋势', children: trendDashboard },
            { key: 'common', label: '通用看板', children: commonDashboard },
            { key: 'game', label: `${gameConfig.displayName}专属`, children: gameSpecificDashboard },
            { key: 'players', label: '玩家明细', children: playerDetail },
            { key: 'quality', label: '数据质量', children: qualityDashboard },
          ]}
        />
      </Content>
    </Layout>
  );
}

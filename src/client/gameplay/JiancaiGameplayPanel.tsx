import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Card, Col, Empty, Row, Space, Statistic, Table, Tabs, Tooltip, Typography, message } from 'antd';

import { appendPlatformQuery } from '../../shared/platforms';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import ReactECharts from '../components/AnalyticsChart';
import { buildWindowQuery, type WindowValue } from '../timeWindow';
import { CHART_GRID_WITH_ZOOM, CHART_LEGEND_TOP, makeDataZoom } from './utils';

const { Text } = Typography;

interface FunnelStep {
  key: string;
  label: string;
  users: number;
  rate_from_top: number | null;
  drop_from_prev: number | null;
  lost_from_prev: number;
}

interface JiancaiGameplayResponse {
  ok: boolean;
  kpi?: {
    dau: number;
    play_users: number;
    session_cnt: number;
    play_minutes: number;
    avg_session_ms: number;
    median_session_ms: number;
    minutes_per_user: number;
    duration_source: string;
    outing_start_cnt: number;
    outing_complete_cnt: number;
    outing_abandon_cnt: number;
    outing_complete_rate: number | null;
    outing_users: number;
    avg_outing_ms: number;
    ad_show_cnt: number;
    ad_complete_cnt: number;
    ad_revenue_estimated_cny: number;
    arpdau_estimated_cny: number;
  };
  session_buckets?: Array<{ range_label: string; count: number }>;
  daily?: Array<{
    date_key: string;
    dau: number;
    play_minutes: number;
    minutes_per_user: number;
    outing_starts: number;
    outing_completes: number;
    tutorial_done_users: number;
    ad_show_cnt: number;
    ad_revenue_estimated_cny: number;
  }>;
  markets?: Array<{
    market_id: string;
    start_cnt: number;
    start_users: number;
    complete_cnt: number;
    complete_users: number;
    abandon_cnt: number;
    complete_rate: number | null;
    avg_duration_ms: number;
    avg_item_count: number;
    safe_cnt: number;
    messy_cnt: number;
  }>;
  ad_scenes?: Array<{
    scene: string;
    shows: number;
    completes: number;
    complete_rate: number | null;
    revenue_estimated_cny: number;
  }>;
  cold_start?: {
    new_users: number;
    returning_users: number;
    bounce_under_1min: number;
    bounce_rate: number | null;
    took_loot_users: number;
    took_loot_rate: number | null;
    tutorial_done_users: number;
    tutorial_done_rate: number | null;
    first_outing_users: number;
    first_outing_rate: number | null;
    first_extract_users: number;
    first_extract_rate: number | null;
    funnel: FunnelStep[];
    tutorial_steps: FunnelStep[];
    dwell_buckets: Array<{
      range_label: string;
      users: number;
      share: number;
      took_loot: number;
      tutorial_done: number;
      tutorial_done_rate: number | null;
    }>;
    devices: Array<{
      brand: string;
      users: number;
      reached_loot: number;
      reach_rate: number | null;
      bounce_under_1min: number;
      bounce_rate: number | null;
    }>;
    errors: Array<{ err_msg: string; count: number; users: number }>;
  };
  code?: string;
  error?: string;
}

const MARKET_LABELS: Record<string, string> = {
  xiangko: '巷口收摊',
  heyan: '河沿早市',
  qiaotou: '桥头早市',
  shanwu: '山坞早集',
  jiangbian: '江边渔市',
  nanshi: '南门菜市',
  laocheng: '老城菜行',
  dukou: '渡口渔行',
  shanzhen: '山珍行',
};

const SCENE_LABELS: Record<string, string> = {
  basket: '菜篮 - 看广告解锁弹性格',
  stamina: '体力不足 - 看广告回体力',
  special: '特殊菜场 - 看广告出门',
};

function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${(value * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (!ms) return '-';
  const sec = Math.round(ms / 1000);
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

function KpiRow({ items }: {
  items: Array<{ title: string; value: string | number; suffix?: string; precision?: number; hint?: string }>;
}) {
  return (
    <Row gutter={[16, 16]}>
      {items.map((item) => (
        <Col xs={12} md={6} key={item.title}>
          <Card size="small">
            {item.hint ? (
              <Tooltip title={item.hint}>
                <Statistic title={item.title} value={item.value} suffix={item.suffix} precision={item.precision} />
              </Tooltip>
            ) : (
              <Statistic title={item.title} value={item.value} suffix={item.suffix} precision={item.precision} />
            )}
          </Card>
        </Col>
      ))}
    </Row>
  );
}

export function JiancaiGameplayPanel() {
  const { gameKey, platform, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<JiancaiGameplayResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async (nextGameKey: string, nextWindow: WindowValue) => {
    const seq = ++requestSeqRef.current;
    try {
      const queryStr = appendPlatformQuery(buildWindowQuery(nextWindow), platform);
      const res = await fetch(`/api/realtime/jiancai-gameplay?game=${encodeURIComponent(nextGameKey)}&${queryStr}`);
      const json = (await res.json()) as JiancaiGameplayResponse;
      if (seq !== requestSeqRef.current) return;
      if (!json.ok) message.error(`获取扫荡菜场玩法数据失败: ${json.error || json.code}`);
      setData(json);
      setLastRefreshedAt(Date.now());
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      message.error(`加载扫荡菜场玩法数据失败: ${String(error)}`);
    }
  }, [platform, setLastRefreshedAt]);

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, platform, windowSel, refreshToken, load]);

  const kpi = data?.kpi;
  const daily = data?.daily || [];
  const cold = data?.cold_start;
  const dates = useMemo(() => daily.map((d) => d.date_key.slice(5)), [daily]);

  const funnelOption = useMemo(() => {
    const steps = cold?.funnel || [];
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: Array<{ dataIndex: number }>) => {
          const step = steps[params?.[0]?.dataIndex ?? 0];
          if (!step) return '';
          return [
            step.label,
            `到达 ${step.users} 人`,
            `占新用户 ${pct(step.rate_from_top)}`,
            step.drop_from_prev !== null
              ? `较上一步流失 ${pct(step.drop_from_prev)}（${step.lost_from_prev} 人）`
              : '',
          ].filter(Boolean).join('<br/>');
        },
      },
      grid: { left: 8, right: 72, top: 8, bottom: 8, containLabel: true },
      xAxis: { type: 'value', name: '人' },
      yAxis: { type: 'category', data: steps.map((s) => s.label), inverse: true },
      series: [{
        type: 'bar',
        barMaxWidth: 20,
        label: {
          show: true,
          position: 'right',
          formatter: (p: { dataIndex: number }) => {
            const step = steps[p.dataIndex];
            return step ? `${step.users}（${pct(step.rate_from_top)}）` : '';
          },
        },
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: (p: { dataIndex: number }) => {
            const step = steps[p.dataIndex];
            return step && (step.drop_from_prev || 0) >= 0.25 ? '#e11d48' : '#2563eb';
          },
        },
        data: steps.map((s) => s.users),
      }],
    };
  }, [cold?.funnel]);

  const dwellOption = useMemo(() => {
    const buckets = cold?.dwell_buckets || [];
    return {
      tooltip: {
        trigger: 'axis',
        formatter: (params: Array<{ dataIndex: number }>) => {
          const b = buckets[params?.[0]?.dataIndex ?? 0];
          if (!b) return '';
          return [
            b.range_label,
            `新用户 ${b.users} 人（${pct(b.share)}）`,
            `捡到第一份菜 ${b.took_loot} 人`,
            `引导完成 ${b.tutorial_done} 人（${pct(b.tutorial_done_rate)}）`,
          ].join('<br/>');
        },
      },
      legend: { data: ['新用户', '引导完成率'], ...CHART_LEGEND_TOP },
      grid: { left: 48, right: 56, top: 40, bottom: 40 },
      xAxis: { type: 'category', data: buckets.map((b) => b.range_label) },
      yAxis: [
        { type: 'value', name: '新用户', minInterval: 1 },
        { type: 'value', name: '%', min: 0, max: 100 },
      ],
      series: [
        {
          name: '新用户',
          type: 'bar',
          barMaxWidth: 36,
          itemStyle: {
            borderRadius: [4, 4, 0, 0],
            color: (p: { dataIndex: number }) => (p.dataIndex <= 1 ? '#e11d48' : '#2563eb'),
          },
          data: buckets.map((b) => b.users),
        },
        {
          name: '引导完成率',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          itemStyle: { color: '#059669' },
          data: buckets.map((b) => (b.tutorial_done_rate === null ? null : +(b.tutorial_done_rate * 100).toFixed(1))),
        },
      ],
    };
  }, [cold?.dwell_buckets]);

  const worstStep = useMemo(() => {
    const steps = (cold?.funnel || []).filter((s) => s.drop_from_prev !== null && s.lost_from_prev > 0);
    if (steps.length === 0) return null;
    return steps.reduce((best, row) => (row.lost_from_prev > best.lost_from_prev ? row : best));
  }, [cold?.funnel]);

  const scaleOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    legend: { data: ['DAU', '人均时长(分)'], ...CHART_LEGEND_TOP },
    grid: { ...CHART_GRID_WITH_ZOOM, right: 56 },
    xAxis: { type: 'category', data: dates, axisLabel: { hideOverlap: true } },
    yAxis: [
      { type: 'value', name: '人', minInterval: 1 },
      { type: 'value', name: '分钟', min: 0 },
    ],
    dataZoom: makeDataZoom(),
    series: [
      {
        name: 'DAU',
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#2563eb', borderRadius: [4, 4, 0, 0] },
        data: daily.map((d) => d.dau),
      },
      {
        name: '人均时长(分)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        itemStyle: { color: '#7c3aed' },
        data: daily.map((d) => d.minutes_per_user),
      },
    ],
  }), [daily, dates]);

  const sessionOption = useMemo(() => {
    const buckets = data?.session_buckets || [];
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 48, right: 24, top: 24, bottom: 40 },
      xAxis: { type: 'category', data: buckets.map((b) => b.range_label) },
      yAxis: { type: 'value', name: '会话数', minInterval: 1 },
      series: [{
        name: '会话数',
        type: 'bar',
        barMaxWidth: 28,
        itemStyle: { color: '#2563eb', borderRadius: [4, 4, 0, 0] },
        data: buckets.map((b) => b.count),
      }],
    };
  }, [data?.session_buckets]);

  const outingOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    legend: { data: ['出门', '收摊回家'], ...CHART_LEGEND_TOP },
    grid: { ...CHART_GRID_WITH_ZOOM },
    xAxis: { type: 'category', data: dates, axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', name: '次', minInterval: 1 },
    dataZoom: makeDataZoom(),
    series: [
      {
        name: '出门',
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#94a3b8', borderRadius: [4, 4, 0, 0] },
        data: daily.map((d) => d.outing_starts),
      },
      {
        name: '收摊回家',
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#059669', borderRadius: [4, 4, 0, 0] },
        data: daily.map((d) => d.outing_completes),
      },
    ],
  }), [daily, dates]);

  const adOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    legend: { data: ['广告曝光', '估算收益(元)'], ...CHART_LEGEND_TOP },
    grid: { ...CHART_GRID_WITH_ZOOM, right: 56 },
    xAxis: { type: 'category', data: dates, axisLabel: { hideOverlap: true } },
    yAxis: [
      { type: 'value', name: '次', minInterval: 1 },
      { type: 'value', name: '元', min: 0 },
    ],
    dataZoom: makeDataZoom(),
    series: [
      {
        name: '广告曝光',
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#d97706', borderRadius: [4, 4, 0, 0] },
        data: daily.map((d) => d.ad_show_cnt),
      },
      {
        name: '估算收益(元)',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        itemStyle: { color: '#059669' },
        data: daily.map((d) => d.ad_revenue_estimated_cny),
      },
    ],
  }), [daily, dates]);

  if (!kpi) {
    return (
      <Card title="扫荡菜场 · 玩法分析">
        <Empty description="暂无扫荡菜场玩法事件。切到 jiancai 后，窗口内有进游戏才会出数。" />
      </Card>
    );
  }

  const onboardingTab = cold && cold.new_users > 0 ? (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {worstStep && (
        <Alert
          type="error"
          showIcon
          message={`最大断点：${worstStep.label}`}
          description={
            `${cold.new_users} 个新用户里，走到「${worstStep.label}」时较上一步掉了 `
            + `${pct(worstStep.drop_from_prev)}（${worstStep.lost_from_prev} 人）。`
            + ` 捡到第一份菜 ${cold.took_loot_users} 人（${pct(cold.took_loot_rate)}），`
            + `引导完成 ${cold.tutorial_done_users} 人（${pct(cold.tutorial_done_rate)}），`
            + `停留不足 1 分钟 ${cold.bounce_under_1min} 人（${pct(cold.bounce_rate)}）。`
            + ' 引导埋点是离开该步才打，卡在开场里的人不会进「过开场」。'
          }
        />
      )}

      <KpiRow items={[
        { title: '新用户', value: cold.new_users, suffix: '人', hint: `窗口内老玩家 ${cold.returning_users} 人，已从漏斗里剔除` },
        { title: '1分钟内流失', value: pct(cold.bounce_rate), hint: '窗口内首末事件间隔 <1 分钟的新用户占比' },
        { title: '捡到第一份菜', value: pct(cold.took_loot_rate), hint: '走到 take_loot，说明已经会翻摊抽菜' },
        { title: '引导完成', value: pct(cold.tutorial_done_rate), hint: 'tutorial_step.completed，整段厨房→菜场→炒卖走完' },
      ]} />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card type="inner" title="冷启动漏斗（红=较上一步掉超 25%）">
            {(cold.funnel || []).some((s) => s.users > 0)
              ? <ReactECharts option={funnelOption} style={{ height: 420 }} />
              : <Empty description="窗口内没有引导埋点" />}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            type="inner"
            title="停留时长 × 引导完成率"
            extra={<Text type="secondary" style={{ fontSize: 12 }}>分清「秒退」和「玩了一会儿没走完」</Text>}
          >
            {(cold.dwell_buckets || []).length > 0
              ? <ReactECharts option={dwellOption} style={{ height: 420 }} />
              : <Empty description="窗口内没有新用户" />}
          </Card>
        </Col>
      </Row>

      <Table
        size="small"
        rowKey="key"
        title={() => '引导每一步（离开该步才计数）'}
        dataSource={cold.tutorial_steps || []}
        pagination={false}
        locale={{ emptyText: '窗口内没有引导埋点' }}
        columns={[
          { title: '步骤', dataIndex: 'label' },
          { title: '到达', dataIndex: 'users', align: 'right' },
          { title: '占新用户', dataIndex: 'rate_from_top', align: 'right', render: pct },
          {
            title: '较上一步流失',
            dataIndex: 'drop_from_prev',
            align: 'right',
            render: (v: number | null, row: FunnelStep) => (
              <Text type={v !== null && v >= 0.25 ? 'danger' : undefined}>
                {row.key === 'new_user' ? '-' : `${pct(v)}（${row.lost_from_prev}）`}
              </Text>
            ),
          },
        ]}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Table
            size="small"
            rowKey="brand"
            title={() => '机型：谁没捡到第一份菜'}
            dataSource={cold.devices || []}
            pagination={false}
            locale={{ emptyText: '窗口内没有机型数据' }}
            columns={[
              { title: '品牌', dataIndex: 'brand' },
              { title: '新用户', dataIndex: 'users', align: 'right' },
              {
                title: '到捡菜',
                dataIndex: 'reach_rate',
                align: 'right',
                render: (v: number | null) => <Text type={v !== null && v < 0.15 ? 'danger' : undefined}>{pct(v)}</Text>,
              },
              { title: '1分钟流失', dataIndex: 'bounce_rate', align: 'right', render: pct },
            ]}
          />
        </Col>
        <Col xs={24} lg={12}>
          <Table
            size="small"
            rowKey="err_msg"
            title={() => '前端报错 Top（app_error）'}
            dataSource={cold.errors || []}
            pagination={false}
            locale={{ emptyText: '窗口内没有上报报错' }}
            columns={[
              { title: '报错', dataIndex: 'err_msg', ellipsis: true },
              { title: '次数', dataIndex: 'count', align: 'right', width: 72 },
              { title: '人数', dataIndex: 'users', align: 'right', width: 72 },
            ]}
          />
        </Col>
      </Row>
    </Space>
  ) : <Empty description="窗口内没有新用户，换个时间窗口看看" />;

  const engagementTab = (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <KpiRow items={[
        {
          title: '窗口 DAU',
          value: kpi.dau,
          suffix: '人',
          hint: '只数 session_start，和首页、逐日柱同一口径',
        },
        { title: '人均时长', value: kpi.minutes_per_user, suffix: '分钟' },
        { title: '会话中位', value: formatDuration(kpi.median_session_ms) },
        {
          title: '会话数',
          value: kpi.session_cnt,
          suffix: '次',
          hint: '按相邻事件间隔 ≤5 分钟拼会话，单段短于 15 秒不计',
        },
      ]} />

      <Card type="inner" title="逐日规模与时长">
        {daily.length > 0
          ? <ReactECharts option={scaleOption} style={{ height: 300 }} />
          : <Empty description="窗口内没有逐日数据" />}
      </Card>

      <Card type="inner" title="单次会话时长分布（全体用户，含老玩家）">
        {(data?.session_buckets?.length || 0) > 0
          ? <ReactECharts option={sessionOption} style={{ height: 280 }} />
          : <Empty description="窗口内拼不出有效会话" />}
      </Card>
    </Space>
  );

  const outingTab = (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <KpiRow items={[
        { title: '出门人次', value: kpi.outing_users, suffix: '人' },
        { title: '出门次数', value: kpi.outing_start_cnt, suffix: '次' },
        { title: '收摊回家率', value: pct(kpi.outing_complete_rate), hint: 'quest_complete / quest_start' },
        { title: '场均出门', value: formatDuration(kpi.avg_outing_ms), hint: '按 quest_complete.duration_ms' },
      ]} />

      <Card type="inner" title="逐日出门与收摊">
        {daily.length > 0
          ? <ReactECharts option={outingOption} style={{ height: 300 }} />
          : <Empty description="窗口内没有出门事件" />}
      </Card>

      <Table
        size="small"
        rowKey="market_id"
        title={() => '各菜场出门局'}
        dataSource={data?.markets || []}
        pagination={false}
        locale={{ emptyText: '窗口内没有出门局' }}
        columns={[
          { title: '菜场', dataIndex: 'market_id', render: (v: string) => MARKET_LABELS[v] || v },
          { title: '出门次数', dataIndex: 'start_cnt', align: 'right' },
          { title: '出门人数', dataIndex: 'start_users', align: 'right' },
          { title: '收摊', dataIndex: 'complete_cnt', align: 'right' },
          {
            title: '回家率',
            dataIndex: 'complete_rate',
            align: 'right',
            render: (v: number | null) => <Text type={v !== null && v < 0.6 ? 'danger' : undefined}>{pct(v)}</Text>,
          },
          { title: '未用放弃', dataIndex: 'abandon_cnt', align: 'right' },
          { title: '场均时长', dataIndex: 'avg_duration_ms', align: 'right', render: formatDuration },
          { title: '场均带回', dataIndex: 'avg_item_count', align: 'right' },
          { title: '主动收工', dataIndex: 'safe_cnt', align: 'right' },
          { title: '天黑被赶', dataIndex: 'messy_cnt', align: 'right' },
        ]}
      />
    </Space>
  );

  const monetizationTab = (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <KpiRow items={[
        { title: '广告曝光', value: kpi.ad_show_cnt, suffix: '次' },
        { title: '完播', value: kpi.ad_complete_cnt, suffix: '次' },
        {
          title: '估算广告收益',
          value: kpi.ad_revenue_estimated_cny,
          suffix: '元',
          precision: 2,
          hint: '按 jiancai.reward eCPM 估算，不是结算款',
        },
        { title: '估算 ARPDAU', value: kpi.arpdau_estimated_cny, suffix: '元', precision: 2 },
      ]} />

      <Card type="inner" title="逐日广告曝光与估算收益">
        {daily.length > 0
          ? <ReactECharts option={adOption} style={{ height: 300 }} />
          : <Empty description="窗口内没有逐日数据" />}
      </Card>

      <Table
        size="small"
        rowKey="scene"
        title={() => '广告位表现'}
        dataSource={data?.ad_scenes || []}
        pagination={false}
        locale={{ emptyText: '窗口内没有广告事件' }}
        columns={[
          { title: '广告位', dataIndex: 'scene', render: (v: string) => SCENE_LABELS[v] || v },
          { title: '曝光', dataIndex: 'shows', align: 'right' },
          { title: '完播', dataIndex: 'completes', align: 'right' },
          { title: '完播率', dataIndex: 'complete_rate', align: 'right', render: pct },
          { title: '估算元', dataIndex: 'revenue_estimated_cny', align: 'right' },
        ]}
      />
    </Space>
  );

  return (
    <Card
      title="扫荡菜场 · 玩法分析"
      extra={<Text type="secondary" style={{ fontSize: 12 }}>指标只服务 jiancai，不与其它游戏面板串数</Text>}
    >
      <Tabs
        defaultActiveKey="onboarding"
        items={[
          { key: 'onboarding', label: `新手漏斗${cold?.new_users ? `（${cold.new_users} 新用户）` : ''}`, children: onboardingTab },
          { key: 'engagement', label: '规模与时长', children: engagementTab },
          { key: 'outing', label: '出门局', children: outingTab },
          { key: 'monetization', label: '广告变现', children: monetizationTab },
        ]}
      />
    </Card>
  );
}

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

interface WujinGameplayResponse {
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
    run_start_cnt: number;
    run_clear_cnt: number;
    run_fail_cnt: number;
    run_clear_rate: number | null;
    run_users: number;
    avg_run_ms: number;
    endless_start_cnt: number;
    endless_users: number;
    max_endless_wave: number;
    ad_show_cnt: number;
    ad_complete_cnt: number;
    ad_revenue_estimated_cny: number;
    arpdau_estimated_cny: number;
  };
  session_buckets?: Array<{ range_label: string; count: number }>;
  daily?: Array<{
    date_key: string;
    dau: number;
    minutes_per_user: number;
    run_starts: number;
    run_clears: number;
    ad_show_cnt: number;
    ad_revenue_estimated_cny: number;
  }>;
  dungeons?: Array<{
    dungeon_id: string;
    kind: string;
    start_cnt: number;
    start_users: number;
    clear_cnt: number;
    clear_users: number;
    fail_cnt: number;
    abandon_cnt: number;
    clear_rate: number | null;
    avg_duration_ms: number;
    avg_wave: number;
    max_wave: number;
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
    first_run_users: number;
    first_run_rate: number | null;
    tutorial_clear_users: number;
    tutorial_clear_rate: number | null;
    next_chapter_users: number;
    next_chapter_rate: number | null;
    endless_users: number;
    endless_rate: number | null;
    funnel: FunnelStep[];
    dwell_buckets: Array<{
      range_label: string;
      users: number;
      share: number;
      entered_run: number;
      cleared_tutorial: number;
      tutorial_clear_rate: number | null;
    }>;
    devices: Array<{
      brand: string;
      users: number;
      reached_run: number;
      reach_rate: number | null;
      bounce_under_1min: number;
      bounce_rate: number | null;
    }>;
    errors: Array<{ err_msg: string; count: number; users: number }>;
  };
  code?: string;
  error?: string;
}

const DUNGEON_LABELS: Record<string, string> = {
  dungeon_grassland: '草原战线',
  dungeon_forest: '密林深处',
  dungeon_fortress: '要塞攻防',
  dungeon_swamp: '毒沼泥潭',
  dungeon_dragon: '龙岭绝巅',
  dungeon_bloodfang: '血牙祭坛',
  dungeon_endless: '无尽试炼',
  elite_grassland: '草原精英',
  elite_forest: '密林精英',
  elite_fortress: '要塞精英',
  elite_swamp: '毒沼精英',
  elite_dragon: '龙岭精英',
  elite_bloodfang: '血牙精英',
};

const KIND_LABELS: Record<string, string> = {
  chapter: '章节',
  elite: '精英',
  endless: '无尽',
  other: '其它',
};

const SCENE_LABELS: Record<string, string> = {
  extraDeploy: '上阵编成 - 看广告多上一人',
  revive: '战斗失败 - 局内复活一名单位',
  lootRefresh: '战利品三选一 - 看广告刷新选项',
  shopRefresh: '商店节点 - 看广告刷新货架',
  interstitial: '章节断点 - 插屏',
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

export function WujinGameplayPanel() {
  const { gameKey, platform, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<WujinGameplayResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async (nextGameKey: string, nextWindow: WindowValue) => {
    const seq = ++requestSeqRef.current;
    try {
      const queryStr = appendPlatformQuery(buildWindowQuery(nextWindow), platform);
      const res = await fetch(`/api/realtime/wujin-gameplay?game=${encodeURIComponent(nextGameKey)}&${queryStr}`);
      const json = (await res.json()) as WujinGameplayResponse;
      if (seq !== requestSeqRef.current) return;
      if (!json.ok) message.error(`获取无尽纹章玩法数据失败: ${json.error || json.code}`);
      setData(json);
      setLastRefreshedAt(Date.now());
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      message.error(`加载无尽纹章玩法数据失败: ${String(error)}`);
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
            `进过首局 ${b.entered_run} 人`,
            `通关教学章 ${b.cleared_tutorial} 人（${pct(b.tutorial_clear_rate)}）`,
          ].join('<br/>');
        },
      },
      legend: { data: ['新用户', '教学章通关率'], ...CHART_LEGEND_TOP },
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
          name: '教学章通关率',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          itemStyle: { color: '#059669' },
          data: buckets.map((b) => (b.tutorial_clear_rate === null ? null : +(b.tutorial_clear_rate * 100).toFixed(1))),
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

  const runOption = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    legend: { data: ['开局', '通关'], ...CHART_LEGEND_TOP },
    grid: { ...CHART_GRID_WITH_ZOOM },
    xAxis: { type: 'category', data: dates, axisLabel: { hideOverlap: true } },
    yAxis: { type: 'value', name: '次', minInterval: 1 },
    dataZoom: makeDataZoom(),
    series: [
      {
        name: '开局',
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#94a3b8', borderRadius: [4, 4, 0, 0] },
        data: daily.map((d) => d.run_starts),
      },
      {
        name: '通关',
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color: '#059669', borderRadius: [4, 4, 0, 0] },
        data: daily.map((d) => d.run_clears),
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
      <Card title="无尽纹章 · 玩法分析">
        <Empty description="暂无无尽纹章玩法事件。切到 wujin_wenzhang 后，窗口内有进游戏才会出数。" />
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
            + ` 进过首局 ${cold.first_run_users} 人（${pct(cold.first_run_rate)}），`
            + `通关教学章 ${cold.tutorial_clear_users} 人（${pct(cold.tutorial_clear_rate)}），`
            + `停留不足 1 分钟 ${cold.bounce_under_1min} 人（${pct(cold.bounce_rate)}）。`
            + ' 端上还没打引导逐步点，漏斗用开局/通关事件代替。'
          }
        />
      )}

      <KpiRow items={[
        { title: '新用户', value: cold.new_users, suffix: '人', hint: `窗口内老玩家 ${cold.returning_users} 人，已从漏斗里剔除` },
        { title: '1分钟内流失', value: pct(cold.bounce_rate), hint: '窗口内首末事件间隔 <1 分钟的新用户占比' },
        { title: '进过首局', value: pct(cold.first_run_rate), hint: '任意正式副本 level_start' },
        { title: '通关教学章', value: pct(cold.tutorial_clear_rate), hint: '草原战线 level_clear' },
      ]} />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card type="inner" title="冷启动漏斗（红=较上一步掉超 25%）">
            {(cold.funnel || []).some((s) => s.users > 0)
              ? <ReactECharts option={funnelOption} style={{ height: 360 }} />
              : <Empty description="窗口内没有对局埋点" />}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            type="inner"
            title="停留时长 × 教学章通关率"
            extra={<Text type="secondary" style={{ fontSize: 12 }}>分清「秒退」和「打了一会儿没过」</Text>}
          >
            {(cold.dwell_buckets || []).length > 0
              ? <ReactECharts option={dwellOption} style={{ height: 360 }} />
              : <Empty description="窗口内没有新用户" />}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Table
            size="small"
            rowKey="brand"
            title={() => '机型：谁没进首局'}
            dataSource={cold.devices || []}
            pagination={false}
            locale={{ emptyText: '窗口内没有机型数据' }}
            columns={[
              { title: '品牌', dataIndex: 'brand' },
              { title: '新用户', dataIndex: 'users', align: 'right' },
              {
                title: '到首局',
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
        {
          title: '人均时长',
          value: kpi.minutes_per_user,
          suffix: '分钟',
          hint: '全游戏标准口径：相邻事件 ≤5 分钟拼会话，和大盘「人均时长」同一套',
        },
        { title: '会话中位', value: formatDuration(kpi.median_session_ms) },
        { title: '会话数', value: kpi.session_cnt, suffix: '次' },
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

  const dungeonTab = (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <KpiRow items={[
        { title: '开局人次', value: kpi.run_users, suffix: '人' },
        { title: '开局次数', value: kpi.run_start_cnt, suffix: '次' },
        { title: '通关率', value: pct(kpi.run_clear_rate), hint: 'level_clear / level_start' },
        { title: '场均时长', value: formatDuration(kpi.avg_run_ms) },
      ]} />

      <KpiRow items={[
        { title: '无尽人次', value: kpi.endless_users, suffix: '人' },
        { title: '无尽开局', value: kpi.endless_start_cnt, suffix: '次' },
        { title: '最高波次', value: kpi.max_endless_wave, suffix: '波' },
        { title: '失败/放弃', value: kpi.run_fail_cnt, suffix: '次' },
      ]} />

      <Card type="inner" title="逐日开局与通关">
        {daily.length > 0
          ? <ReactECharts option={runOption} style={{ height: 300 }} />
          : <Empty description="窗口内没有对局事件" />}
      </Card>

      <Table
        size="small"
        rowKey="dungeon_id"
        title={() => '各章节 / 精英 / 无尽'}
        dataSource={data?.dungeons || []}
        pagination={false}
        locale={{ emptyText: '窗口内没有对局' }}
        columns={[
          { title: '副本', dataIndex: 'dungeon_id', render: (v: string) => DUNGEON_LABELS[v] || v },
          { title: '类型', dataIndex: 'kind', render: (v: string) => KIND_LABELS[v] || v },
          { title: '开局次数', dataIndex: 'start_cnt', align: 'right' },
          { title: '开局人数', dataIndex: 'start_users', align: 'right' },
          { title: '通关', dataIndex: 'clear_cnt', align: 'right' },
          {
            title: '通关率',
            dataIndex: 'clear_rate',
            align: 'right',
            render: (v: number | null) => <Text type={v !== null && v < 0.4 ? 'danger' : undefined}>{pct(v)}</Text>,
          },
          { title: '失败', dataIndex: 'fail_cnt', align: 'right' },
          { title: '放弃', dataIndex: 'abandon_cnt', align: 'right' },
          { title: '场均时长', dataIndex: 'avg_duration_ms', align: 'right', render: formatDuration },
          { title: '场均波/节点', dataIndex: 'avg_wave', align: 'right' },
          { title: '最高波', dataIndex: 'max_wave', align: 'right' },
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
          hint: '按 wujin_wenzhang.reward eCPM 估算，不是结算款',
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
      title="无尽纹章 · 玩法分析"
      extra={<Text type="secondary" style={{ fontSize: 12 }}>指标只服务 wujin_wenzhang；人均时长与大盘同一口径</Text>}
    >
      <Tabs
        defaultActiveKey="onboarding"
        items={[
          { key: 'onboarding', label: `新手漏斗${cold?.new_users ? `（${cold.new_users} 新用户）` : ''}`, children: onboardingTab },
          { key: 'engagement', label: '规模与时长', children: engagementTab },
          { key: 'dungeon', label: '章节 / 无尽', children: dungeonTab },
          { key: 'monetization', label: '广告变现', children: monetizationTab },
        ]}
      />
    </Card>
  );
}

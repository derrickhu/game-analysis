import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Card, Col, Empty, Row, Space, Statistic, Table, Tabs, Tooltip, Typography, message } from 'antd';

import { appendPlatformQuery } from '../../shared/platforms';
import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import ReactECharts from '../components/AnalyticsChart';
import { buildWindowQuery, type WindowValue } from '../timeWindow';
import { CHART_GRID_WITH_ZOOM, CHART_LEGEND_TOP, makeDataZoom } from './utils';

const { Text } = Typography;

interface PetTowerGameplayResponse {
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
    ad_show_cnt: number;
    ad_complete_cnt: number;
    ad_revenue_estimated_cny: number;
    arpdau_estimated_cny: number;
    tower_start_cnt: number;
    tower_clear_cnt: number;
    tower_clear_rate: number | null;
    tower_reset_cnt: number;
    max_floor: number;
  };
  mismatch?: {
    tower_avg_clear_ms: number;
    mainline_avg_clear_ms: number;
    duration_ratio: number | null;
    late_band_label: string;
    late_band_avg_coins: number;
    late_band_clear_rate: number | null;
    shop_coin_pack_marks: number;
    tower_minutes_for_coin_pack: number | null;
    wall_floors: number[];
  };
  session_buckets?: Array<{ range_label: string; count: number }>;
  daily?: Array<{
    date_key: string;
    dau: number;
    play_minutes: number;
    minutes_per_user: number;
    ad_show_cnt: number;
    ad_revenue_estimated_cny: number;
    tower_starts: number;
    tower_clears: number;
  }>;
  floor_bands?: Array<{
    band_label: string;
    starts: number;
    clears: number;
    clear_rate: number | null;
    avg_coins: number;
    coins_sum: number;
    difficulty_mid: number;
  }>;
  wall_floors?: Array<{
    floor: number;
    starts: number;
    clears: number;
    clear_rate: number | null;
    avg_coins: number;
    difficulty: number;
  }>;
  battle_modes?: Array<{
    mode: string;
    clears: number;
    avg_duration_ms: number;
    avg_turns: number;
  }>;
  ad_scenes?: Array<{
    scene: string;
    shows: number;
    completes: number;
    complete_rate: number | null;
    revenue_estimated_cny: number;
  }>;
  exchanges?: Array<{ option_id: string; count: number; cost_sum: number }>;
  cold_start?: {
    new_users: number;
    returning_users: number;
    bounce_under_1min: number;
    bounce_rate: number | null;
    reached_first_match: number;
    first_match_rate: number | null;
    first_level_clear_users: number;
    first_level_clear_rate: number | null;
    funnel: Array<{
      key: string;
      label: string;
      users: number;
      rate_from_top: number | null;
      drop_from_prev: number | null;
      lost_from_prev: number;
    }>;
    dwell_buckets: Array<{
      range_label: string;
      users: number;
      share: number;
      entered_first_level: number;
      cleared_first_level: number;
      first_clear_rate: number | null;
    }>;
    early_levels: Array<{
      level_name: string;
      start_users: number;
      clear_users: number;
      fail_users: number;
      clear_rate: number | null;
      retry_per_user: number;
      avg_turns_clear: number;
      avg_turns_fail: number;
      avg_duration_ms: number;
    }>;
    devices: Array<{
      brand: string;
      users: number;
      reached_battle: number;
      reach_rate: number | null;
      bounce_under_1min: number;
      bounce_rate: number | null;
    }>;
    errors: Array<{ err_msg: string; count: number; users: number }>;
  };
  code?: string;
  error?: string;
}

const MODE_LABELS: Record<string, string> = {
  mainline: '主线',
  tower: '通天塔',
  realm: '秘境',
  other: '其它',
};

const SCENE_LABELS: Record<string, string> = {
  victory_double: '结算翻倍',
  victory_home: '结算回城',
  quest_double: '日常翻倍',
  battle_revive: '战斗复活',
  realm_extra_run: '秘境加次',
  stamina_refill: '体力回复',
  free_gacha_pull: '免费召唤',
  checkin_double: '签到翻倍',
  tower_reset: '通天塔重置',
};

const EXCHANGE_LABELS: Record<string, string> = {
  tex_coins: '印记兑灵宠币',
  tex_lingyu: '印记兑灵玉',
  tex_universal: '印记兑通用碎片',
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

/** 四个一排的 KPI，避免十个指标糊成一堵墙 */
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

export function PetTowerGameplayPanel() {
  const { gameKey, platform, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [data, setData] = useState<PetTowerGameplayResponse | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(async (nextGameKey: string, nextWindow: WindowValue) => {
    const seq = ++requestSeqRef.current;
    try {
      const queryStr = appendPlatformQuery(buildWindowQuery(nextWindow), platform);
      const res = await fetch(`/api/realtime/pet-tower-gameplay?game=${encodeURIComponent(nextGameKey)}&${queryStr}`);
      const json = (await res.json()) as PetTowerGameplayResponse;
      if (seq !== requestSeqRef.current) return;
      if (!json.ok) message.error(`获取塔2玩法数据失败: ${json.error || json.code}`);
      setData(json);
      setLastRefreshedAt(Date.now());
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      message.error(`加载塔2玩法数据失败: ${String(error)}`);
    }
  }, [platform, setLastRefreshedAt]);

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, platform, windowSel, refreshToken, load]);

  const kpi = data?.kpi;
  const mismatch = data?.mismatch;
  const daily = data?.daily || [];
  const cold = data?.cold_start;
  const dates = useMemo(() => daily.map((d) => d.date_key.slice(5)), [daily]);

  // 漏斗用横向条形：节点名长，竖着放会挤成一团
  const funnelOption = useMemo(() => {
    const steps = (cold?.funnel || []).filter((s) => s.users > 0);
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
          // 相对上一步流失超过 25% 标红，一眼找断点
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
            `进过首关 ${b.entered_first_level} 人`,
            `通过首关 ${b.cleared_first_level} 人（${pct(b.first_clear_rate)}）`,
          ].join('<br/>');
        },
      },
      legend: { data: ['新用户', '首关通过率'], ...CHART_LEGEND_TOP },
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
          name: '首关通过率',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          itemStyle: { color: '#059669' },
          data: buckets.map((b) => (b.first_clear_rate === null ? null : +(b.first_clear_rate * 100).toFixed(1))),
        },
      ],
    };
  }, [cold?.dwell_buckets]);

  // 断点取「流失人数最多」而不是比例最高，避免小样本尾部节点抢戏
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

  const bandOption = useMemo(() => {
    const bands = data?.floor_bands || [];
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['开始', '通关', '通关率', '层中难度'], ...CHART_LEGEND_TOP },
      grid: { ...CHART_GRID_WITH_ZOOM, right: 56 },
      xAxis: { type: 'category', data: bands.map((b) => b.band_label) },
      yAxis: [
        { type: 'value', name: '次数', minInterval: 1 },
        { type: 'value', name: '比率 / 系数', min: 0 },
      ],
      dataZoom: makeDataZoom(),
      series: [
        {
          name: '开始',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#94a3b8', borderRadius: [4, 4, 0, 0] },
          data: bands.map((b) => b.starts),
        },
        {
          name: '通关',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#059669', borderRadius: [4, 4, 0, 0] },
          data: bands.map((b) => b.clears),
        },
        {
          name: '通关率',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          itemStyle: { color: '#2563eb' },
          data: bands.map((b) => (b.clear_rate === null ? null : +(b.clear_rate * 100).toFixed(1))),
        },
        {
          name: '层中难度',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          itemStyle: { color: '#e11d48' },
          data: bands.map((b) => b.difficulty_mid),
        },
      ],
    };
  }, [data?.floor_bands]);

  if (!kpi) {
    return (
      <Card title="灵宠消消塔 · 玩法分析">
        <Empty description="暂无塔2玩法事件。切到 petTower 并选抖音后，窗口内有对局才会出数。" />
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
            + ` 完成首次消除 ${cold.reached_first_match} 人（${pct(cold.first_match_rate)}），`
            + `通过首关 ${cold.first_level_clear_users} 人（${pct(cold.first_level_clear_rate)}），`
            + `停留不足 1 分钟 ${cold.bounce_under_1min} 人（${pct(cold.bounce_rate)}）。`
          }
        />
      )}

      <KpiRow items={[
        { title: '新用户', value: cold.new_users, suffix: '人', hint: `窗口内老玩家 ${cold.returning_users} 人，已从漏斗里剔除` },
        { title: '1分钟内流失', value: pct(cold.bounce_rate), hint: '窗口内首末事件间隔 <1 分钟的新用户占比' },
        { title: '完成首次消除', value: pct(cold.first_match_rate) },
        { title: '通过首关', value: pct(cold.first_level_clear_rate) },
      ]} />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card type="inner" title="冷启动漏斗（红=较上一步掉超 25%）">
            {(cold.funnel || []).some((s) => s.users > 0)
              ? <ReactECharts option={funnelOption} style={{ height: 320 }} />
              : <Empty description="窗口内没有引导埋点" />}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            type="inner"
            title="停留时长 × 首关通过率"
            extra={<Text type="secondary" style={{ fontSize: 12 }}>分清「没进来」和「打不过」</Text>}
          >
            {(cold.dwell_buckets || []).length > 0
              ? <ReactECharts option={dwellOption} style={{ height: 320 }} />
              : <Empty description="窗口内没有新用户" />}
          </Card>
        </Col>
      </Row>

      <Table
        size="small"
        rowKey="level_name"
        title={() => '前期关卡：按人去重的通关率'}
        dataSource={cold.early_levels || []}
        pagination={false}
        locale={{ emptyText: '窗口内没有主线关卡事件' }}
        columns={[
          { title: '关卡', dataIndex: 'level_name' },
          { title: '进入人数', dataIndex: 'start_users', align: 'right' },
          { title: '通关人数', dataIndex: 'clear_users', align: 'right' },
          {
            title: '通关率',
            dataIndex: 'clear_rate',
            align: 'right',
            render: (v: number | null) => <Text type={v !== null && v < 0.6 ? 'danger' : undefined}>{pct(v)}</Text>,
          },
          { title: '人均重试', dataIndex: 'retry_per_user', align: 'right' },
          { title: '通关回合', dataIndex: 'avg_turns_clear', align: 'right' },
          { title: '失败回合', dataIndex: 'avg_turns_fail', align: 'right' },
          { title: '场均时长', dataIndex: 'avg_duration_ms', align: 'right', render: formatDuration },
        ]}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Table
            size="small"
            rowKey="brand"
            title={() => '机型：谁没走到首次消除'}
            dataSource={cold.devices || []}
            pagination={false}
            locale={{ emptyText: '窗口内没有机型数据' }}
            columns={[
              { title: '品牌', dataIndex: 'brand' },
              { title: '新用户', dataIndex: 'users', align: 'right' },
              {
                title: '到首次消除',
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
          hint: 'session_end 没有 duration_ms，按相邻事件间隔 ≤5 分钟拼会话',
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
          hint: '按 petTower.reward eCPM 估算，不是结算款',
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

  const towerTab = (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      {mismatch && (mismatch.duration_ratio || 0) >= 2 && (
        <Alert
          type="warning"
          showIcon
          message="爬塔耗时和印记对不上"
          description={
            `塔场均 ${formatDuration(mismatch.tower_avg_clear_ms)}，主线 ${formatDuration(mismatch.mainline_avg_clear_ms)}`
            + `${mismatch.duration_ratio ? `，约 ${mismatch.duration_ratio} 倍。` : '。'}`
            + (mismatch.late_band_label
              ? ` 主要活动在 ${mismatch.late_band_label}；卡墙后场均印记 ${mismatch.late_band_avg_coins}，兑一档灵宠币要 ${mismatch.shop_coin_pack_marks} 印记`
                + (mismatch.tower_minutes_for_coin_pack != null
                  ? `，按这个速度大约要打 ${mismatch.tower_minutes_for_coin_pack} 分钟塔。`
                  : '。')
              : '')
            + (mismatch.wall_floors.length ? ` 卡墙层：${mismatch.wall_floors.map((f) => `F${f}`).join('、')}。` : '')
          }
        />
      )}

      <KpiRow items={[
        { title: '爬塔通关率', value: pct(kpi.tower_clear_rate) },
        { title: '窗口最高层', value: kpi.max_floor, suffix: '层' },
        { title: '爬塔开始', value: kpi.tower_start_cnt, suffix: '次' },
        { title: '塔重置', value: kpi.tower_reset_cnt, suffix: '次' },
      ]} />

      <Card type="inner" title="层段：通关率 vs 难度系数">
        {(data?.floor_bands?.length || 0) > 0
          ? <ReactECharts option={bandOption} style={{ height: 320 }} />
          : <Empty description="窗口内没有 tower_floor_* 事件" />}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Table
            size="small"
            rowKey="band_label"
            title={() => '层段印记'}
            dataSource={data?.floor_bands || []}
            pagination={false}
            locale={{ emptyText: '窗口内没有层段数据' }}
            columns={[
              { title: '层段', dataIndex: 'band_label' },
              { title: '开始', dataIndex: 'starts', align: 'right' },
              { title: '通关率', dataIndex: 'clear_rate', align: 'right', render: pct },
              { title: '场均印记', dataIndex: 'avg_coins', align: 'right' },
              { title: '层中难度', dataIndex: 'difficulty_mid', align: 'right' },
            ]}
          />
        </Col>
        <Col xs={24} lg={12}>
          <Table
            size="small"
            rowKey="floor"
            title={() => '卡墙层（≥5 次开始且通关率 <40%）'}
            dataSource={data?.wall_floors || []}
            pagination={false}
            locale={{ emptyText: '窗口内没有达到样本量的卡墙层' }}
            columns={[
              { title: '层', dataIndex: 'floor', render: (v: number) => `F${v}` },
              { title: '开始', dataIndex: 'starts', align: 'right' },
              { title: '通关率', dataIndex: 'clear_rate', align: 'right', render: pct },
              { title: '场均印记', dataIndex: 'avg_coins', align: 'right' },
              { title: '难度', dataIndex: 'difficulty', align: 'right' },
            ]}
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Table
            size="small"
            rowKey="mode"
            title={() => '战斗耗时对比'}
            dataSource={data?.battle_modes || []}
            pagination={false}
            locale={{ emptyText: '窗口内没有通关事件' }}
            columns={[
              { title: '模式', dataIndex: 'mode', render: (v: string) => MODE_LABELS[v] || v },
              { title: '通关', dataIndex: 'clears', align: 'right' },
              { title: '场均时长', dataIndex: 'avg_duration_ms', align: 'right', render: formatDuration },
              { title: '场均回合', dataIndex: 'avg_turns', align: 'right' },
            ]}
          />
        </Col>
        <Col xs={24} lg={12}>
          <Table
            size="small"
            rowKey="option_id"
            title={() => '印记兑换'}
            dataSource={data?.exchanges || []}
            pagination={false}
            locale={{ emptyText: '窗口内没有兑换' }}
            columns={[
              { title: '商品', dataIndex: 'option_id', render: (v: string) => EXCHANGE_LABELS[v] || v },
              { title: '次数', dataIndex: 'count', align: 'right' },
              { title: '印记消耗', dataIndex: 'cost_sum', align: 'right' },
            ]}
          />
        </Col>
      </Row>
    </Space>
  );

  return (
    <Card
      title="灵宠消消塔 · 玩法分析"
      extra={<Text type="secondary" style={{ fontSize: 12 }}>指标只服务 petTower，不与其它游戏面板串数</Text>}
    >
      <Tabs
        defaultActiveKey="onboarding"
        items={[
          { key: 'onboarding', label: `新手漏斗${cold?.new_users ? `（${cold.new_users} 新用户）` : ''}`, children: onboardingTab },
          { key: 'engagement', label: '规模与时长', children: engagementTab },
          { key: 'monetization', label: '广告变现', children: monetizationTab },
          { key: 'tower', label: '通天塔', children: towerTab },
        ]}
      />
    </Card>
  );
}

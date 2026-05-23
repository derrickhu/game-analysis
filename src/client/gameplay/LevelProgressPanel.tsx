import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Col, Empty, Row, Space, Statistic, Tooltip, Typography, message } from 'antd';
import ReactECharts from 'echarts-for-react';

import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import { buildWindowQuery, type WindowValue } from '../timeWindow';

const { Text } = Typography;

interface ProgressKpi {
  total_starts: number;
  total_clears: number;
  total_fails: number;
  max_cleared_level: number;
  avg_clear_duration_ms: number;
  clear_rate: number | null;
  computed_at: number;
}

interface LevelDistributionRow {
  level_id: number;
  start_users: number;
  clear_users: number;
  fail_users: number;
  pass_rate: number | null;
}

interface ProgressSeriesPoint {
  bucket: string;
  ts: number;
  start_cnt: number;
  clear_cnt: number;
  fail_cnt: number;
}

interface ProgressResponse {
  ok: boolean;
  query?: { game_key: string; from: string; to: string; window_minutes: number };
  kpi?: ProgressKpi;
  distribution?: LevelDistributionRow[];
  series?: ProgressSeriesPoint[];
  code?: string;
  error?: string;
}

interface LevelPassRateSnapshot {
  game_key: string;
  mode_key: string;
  window_days: number;
  window_start_date: string;
  window_end_date: string;
  computed_at: number;
  levels: Array<{
    level_id: number;
    pass_rate: number;
    start_users: number;
    clear_users: number;
    started_and_cleared_users: number;
    start_attempts: number;
    clear_attempts: number;
    fail_attempts: number;
    is_sample_low: boolean;
  }>;
}

interface LevelPassRateResponse {
  ok: boolean;
  snapshot?: LevelPassRateSnapshot | null;
  code?: string;
  error?: string;
}

function formatDuration(ms: number): string {
  if (!ms) return '-';
  const sec = Math.round(ms / 1000);
  const min = Math.floor(sec / 60);
  const remain = sec % 60;
  return `${min}m ${remain}s`;
}

function bucketShort(bucket: string): string {
  if (!bucket) return '';
  const utcDate = new Date(`${bucket}:00.000Z`);
  if (isNaN(utcDate.getTime())) return bucket;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(utcDate.getMonth() + 1)}-${pad(utcDate.getDate())} ${pad(utcDate.getHours())}:${pad(utcDate.getMinutes())}`;
}

/**
 * 关卡通关漏斗（hotpot 现役 / 后续可拓展到任何 level_start/level_clear/level_fail 三件套游戏）。
 *
 * 数据源：/api/realtime/hotpot-progress（query=game/from/to）。
 * 即使路径上写了 hotpot 命名，但接口本身是按 level_* 事件做去重和聚合，对任何"关卡型"游戏都通用，
 * 后续接彩珠的 match_progress 可直接复用此 panel（届时把后端接口改名 /api/realtime/level-progress 更恰当）。
 *
 * 受全局 AnalyticsFilterContext 控制：gameKey/windowSel/refreshToken 变化都会触发重新拉取。
 */
export function LevelProgressPanel() {
  const { gameKey, windowSel, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [passRateSnapshot, setPassRateSnapshot] = useState<LevelPassRateSnapshot | null>(null);
  const requestSeqRef = useRef(0);

  const load = useCallback(
    async (nextGameKey: string, nextWindow: WindowValue) => {
      const seq = ++requestSeqRef.current;
      try {
        const queryStr = buildWindowQuery(nextWindow);
        const res = await fetch(
          `/api/realtime/hotpot-progress?game=${encodeURIComponent(nextGameKey)}&${queryStr}`,
        );
        const json = (await res.json()) as ProgressResponse;
        if (seq !== requestSeqRef.current) return;
        if (!json.ok) {
          message.error(`获取关卡进度失败: ${json.error || json.code}`);
        }
        setProgress(json);
        if (nextGameKey === 'hotpot') {
          const snapshotRes = await fetch(
            `/api/realtime/level-pass-rates?game=${encodeURIComponent(nextGameKey)}&window_days=30`,
          );
          const snapshotJson = (await snapshotRes.json()) as LevelPassRateResponse;
          if (seq !== requestSeqRef.current) return;
          if (!snapshotJson.ok) {
            message.error(`获取通关率快照失败: ${snapshotJson.error || snapshotJson.code}`);
          }
          setPassRateSnapshot(snapshotJson.snapshot || null);
        } else {
          setPassRateSnapshot(null);
        }
        setLastRefreshedAt(Date.now());
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        message.error(`加载关卡进度失败: ${String(error)}`);
      }
    },
    [setLastRefreshedAt],
  );

  useEffect(() => {
    void load(gameKey, windowSel);
  }, [gameKey, windowSel, refreshToken, load]);

  const levelDistOption = useMemo(() => {
    const dist = progress?.distribution || [];
    const xAxis = dist.map((d) => `第${d.level_id}关`);
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any[]) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const lv = params[0].axisValue;
          const row = dist[params[0].dataIndex];
          if (!row) return lv;
          const passText = row.pass_rate === null ? '-' : `${(row.pass_rate * 100).toFixed(1)}%`;
          return `${lv}<br/>尝试用户: ${row.start_users}<br/>通关用户: ${row.clear_users}<br/>放弃用户: ${row.fail_users}<br/>通关率: ${passText}`;
        },
      },
      legend: {
        data: ['尝试', '通关', '放弃'],
        textStyle: { color: '#374151', fontSize: 13, fontWeight: 500 },
      },
      grid: { left: 50, right: 30, top: 50, bottom: 60 },
      xAxis: { type: 'category', data: xAxis },
      yAxis: { type: 'value', name: '人数', minInterval: 1 },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 10 }],
      series: [
        {
          name: '尝试',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#94a3b8', borderRadius: [4, 4, 0, 0] },
          data: dist.map((d) => d.start_users),
        },
        {
          name: '通关',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] },
          data: dist.map((d) => d.clear_users),
        },
        {
          name: '放弃',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#ef4444', borderRadius: [4, 4, 0, 0] },
          data: dist.map((d) => d.fail_users),
        },
      ],
    };
  }, [progress?.distribution]);

  const levelTrendOption = useMemo(() => {
    const series = progress?.series || [];
    const xAxis = series.map((p) => bucketShort(p.bucket));
    const zoomStart = series.length > 60 ? Math.max(0, 100 - (60 / series.length) * 100) : 0;
    return {
      tooltip: { trigger: 'axis' },
      legend: {
        data: ['开始', '通关', '失败'],
        textStyle: { color: '#374151', fontSize: 13, fontWeight: 500 },
      },
      grid: { left: 50, right: 30, top: 50, bottom: 60 },
      xAxis: { type: 'category', data: xAxis, axisLabel: { hideOverlap: true } },
      yAxis: { type: 'value', name: '次数', minInterval: 1 },
      dataZoom: [
        { type: 'inside', start: zoomStart, end: 100 },
        { type: 'slider', height: 18, bottom: 10, start: zoomStart, end: 100 },
      ],
      series: [
        {
          name: '开始',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#94a3b8' },
          data: series.map((p) => p.start_cnt),
        },
        {
          name: '通关',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#10b981' },
          data: series.map((p) => p.clear_cnt),
        },
        {
          name: '失败',
          type: 'line',
          smooth: true,
          itemStyle: { color: '#ef4444' },
          data: series.map((p) => p.fail_cnt),
        },
      ],
    };
  }, [progress?.series]);

  const progressKpi = progress?.kpi;
  const passRateLevels = passRateSnapshot?.levels || [];
  const passRateSummary = useMemo(() => {
    if (!passRateSnapshot || passRateLevels.length === 0) {
      return null;
    }
    const sorted = [...passRateLevels].sort((a, b) => a.level_id - b.level_id);
    const first = sorted[0];
    const level3 = sorted.find((row) => row.level_id === 3) || null;
    const validRows = sorted.filter((row) => row.start_users >= 10);
    const lowestPass = validRows.reduce<typeof validRows[number] | null>(
      (lowest, row) => (!lowest || row.pass_rate < lowest.pass_rate ? row : lowest),
      null,
    );
    let maxReachDrop: { from_level: number; to_level: number; drop: number } | null = null;
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      if (!prev.start_users) continue;
      const drop = 1 - curr.start_users / prev.start_users;
      if (!maxReachDrop || drop > maxReachDrop.drop) {
        maxReachDrop = { from_level: prev.level_id, to_level: curr.level_id, drop };
      }
    }
    const firstStartUsers = first?.start_users || 0;
    const totalStartUsers = passRateLevels.reduce((sum, row) => sum + row.start_users, 0);
    const totalClearedUsers = passRateLevels.reduce((sum, row) => sum + row.started_and_cleared_users, 0);
    const totalStartAttempts = passRateLevels.reduce((sum, row) => sum + row.start_attempts, 0);
    const lowSampleLevels = passRateLevels.filter((row) => row.start_users < 10).length;
    return {
      firstStartUsers,
      totalStartUsers,
      totalClearedUsers,
      totalStartAttempts,
      lowSampleLevels,
      level3,
      lowestPass,
      maxReachDrop,
      avgPassRate: totalStartUsers > 0 ? totalClearedUsers / totalStartUsers : null,
    };
  }, [passRateLevels, passRateSnapshot]);

  const passRateOption = useMemo(() => {
    const rows = passRateSnapshot?.levels || [];
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: any[]) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const row = rows[params[0].dataIndex];
          if (!row) return '';
          const rateText = row.start_users < 10 ? '少于10人，不对外展示比例' : `${(row.pass_rate * 100).toFixed(1)}%`;
          const reachText = rows[0]?.start_users ? `${((row.start_users / rows[0].start_users) * 100).toFixed(1)}%` : '-';
          const retryText = row.start_users ? `${(row.start_attempts / row.start_users).toFixed(2)}次/人` : '-';
          return `第${row.level_id}关<br/>开始用户: ${row.start_users}<br/>开始次数: ${row.start_attempts}<br/>通关用户: ${row.clear_users}<br/>到达率: ${reachText}<br/>平均尝试: ${retryText}<br/>游戏展示口径: ${rateText}`;
        },
      },
      legend: {
        data: ['开始用户', '通关用户', '单关通关率', '到达率', '平均尝试'],
        textStyle: { color: '#374151', fontSize: 13, fontWeight: 500 },
      },
      grid: { left: 50, right: 56, top: 50, bottom: 62 },
      xAxis: { type: 'category', data: rows.map((row) => `第${row.level_id}关`) },
      yAxis: [
        { type: 'value', name: '人数', minInterval: 1 },
        { type: 'value', name: '通关率', min: 0, max: 1, axisLabel: { formatter: (v: number) => `${Math.round(v * 100)}%` } },
      ],
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 10 }],
      series: [
        {
          name: '开始用户',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#94a3b8', borderRadius: [4, 4, 0, 0] },
          data: rows.map((row) => row.start_users),
        },
        {
          name: '通关用户',
          type: 'bar',
          barMaxWidth: 18,
          itemStyle: { color: '#10b981', borderRadius: [4, 4, 0, 0] },
          data: rows.map((row) => row.clear_users),
        },
        {
          name: '单关通关率',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          itemStyle: { color: '#2563eb' },
          data: rows.map((row) => row.pass_rate),
        },
        {
          name: '到达率',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          itemStyle: { color: '#f59e0b' },
          data: rows.map((row) => (rows[0]?.start_users ? row.start_users / rows[0].start_users : 0)),
        },
        {
          name: '平均尝试',
          type: 'line',
          yAxisIndex: 1,
          smooth: true,
          itemStyle: { color: '#8b5cf6' },
          lineStyle: { type: 'dashed' },
          data: rows.map((row) => (row.start_users ? Math.min(row.start_attempts / row.start_users / 5, 1) : 0)),
        },
      ],
    };
  }, [passRateSnapshot?.levels]);

  return (
    <Card
      title="关卡通关漏斗"
      extra={<Text type="secondary">数据源：level_start / level_clear / level_fail</Text>}
    >
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="总尝试" value={progressKpi?.total_starts ?? 0} suffix="次" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="总通关" value={progressKpi?.total_clears ?? 0} suffix="次" />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="= 通关次数 / 开始次数。失败重试也算独立尝试。">
                <Statistic
                  title="通关率"
                  value={
                    progressKpi?.clear_rate !== null && progressKpi?.clear_rate !== undefined
                      ? (progressKpi.clear_rate * 100).toFixed(1)
                      : '-'
                  }
                  suffix={progressKpi?.clear_rate ? '%' : ''}
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Tooltip title="当前时间窗口内 level_clear 事件中最大的 level_id；切窗口会跟随变化。">
                <Statistic
                  title="窗口内最高通关"
                  value={progressKpi?.max_cleared_level ?? 0}
                  suffix="关"
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic
                title="平均通关耗时"
                value={formatDuration(progressKpi?.avg_clear_duration_ms ?? 0)}
              />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="放弃次数" value={progressKpi?.total_fails ?? 0} suffix="次" />
            </Card>
          </Col>
        </Row>

        <Card type="inner" title="各关卡用户分布（按当前时间窗口去重）">
          {(progress?.distribution?.length || 0) > 0 ? (
            <ReactECharts option={levelDistOption} style={{ height: 320 }} />
          ) : (
            <Empty description="暂无关卡数据，请玩游戏触发 level_start" />
          )}
        </Card>

        <Card
          type="inner"
          title="近30天游戏端通关快照"
          extra={
            passRateSnapshot ? (
              <Text type="secondary">
                {passRateSnapshot.window_start_date} ~ {passRateSnapshot.window_end_date}，每日 04:20 更新
              </Text>
            ) : null
          }
        >
          {passRateSnapshot && passRateSummary ? (
            <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
              <Row gutter={[16, 16]}>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic title="快照关卡数" value={passRateSnapshot.levels.length} suffix="关" />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic title="开始用户合计" value={passRateSummary.totalStartUsers} suffix="人次关" />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Tooltip title="各关 level_start 次数合计，同一用户失败重开会重复计数。">
                      <Statistic title="开始次数合计" value={passRateSummary.totalStartAttempts} suffix="次" />
                    </Tooltip>
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic title="通关用户合计" value={passRateSummary.totalClearedUsers} suffix="人次关" />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic title="少于10人关卡" value={passRateSummary.lowSampleLevels} suffix="关" />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic
                      title="第3关通关率"
                      value={passRateSummary.level3 ? (passRateSummary.level3.pass_rate * 100).toFixed(1) : '-'}
                      suffix={passRateSummary.level3 ? '%' : ''}
                    />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Tooltip title="= 第3关开始次数 / 第3关开始用户。高于 1 说明玩家在重复尝试。">
                      <Statistic
                        title="第3关平均尝试"
                        value={
                          passRateSummary.level3 && passRateSummary.level3.start_users
                            ? (passRateSummary.level3.start_attempts / passRateSummary.level3.start_users).toFixed(2)
                            : '-'
                        }
                        suffix={passRateSummary.level3 ? '次/人' : ''}
                      />
                    </Tooltip>
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic
                      title="第3关到达率"
                      value={
                        passRateSummary.level3 && passRateSummary.firstStartUsers
                          ? ((passRateSummary.level3.start_users / passRateSummary.firstStartUsers) * 100).toFixed(1)
                          : '-'
                      }
                      suffix={passRateSummary.level3 && passRateSummary.firstStartUsers ? '%' : ''}
                    />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic
                      title="最大到达流失"
                      value={
                        passRateSummary.maxReachDrop
                          ? `第${passRateSummary.maxReachDrop.from_level}→${passRateSummary.maxReachDrop.to_level}关`
                          : '-'
                      }
                      suffix={
                        passRateSummary.maxReachDrop
                          ? ` -${(passRateSummary.maxReachDrop.drop * 100).toFixed(1)}%`
                          : ''
                      }
                    />
                  </Card>
                </Col>
                <Col xs={12} md={6}>
                  <Card size="small">
                    <Statistic
                      title="最低通关率关卡"
                      value={passRateSummary.lowestPass ? `第${passRateSummary.lowestPass.level_id}关` : '-'}
                      suffix={
                        passRateSummary.lowestPass ? ` ${(passRateSummary.lowestPass.pass_rate * 100).toFixed(1)}%` : ''
                      }
                    />
                  </Card>
                </Col>
              </Row>
              <Text type="secondary">
                与游戏内读取同一份 MySQL 快照；少于 10 个开始用户的关卡，游戏内只展示“通关少于10人”，不展示比例。
              </Text>
              <ReactECharts option={passRateOption} style={{ height: 340 }} />
            </Space>
          ) : (
            <Empty description="暂无近30天通关率快照，请等待每日任务或手动回算" />
          )}
        </Card>

        <Card type="inner" title="关卡事件趋势（5 分钟桶）">
          {(progress?.series?.length || 0) > 0 ? (
            <ReactECharts option={levelTrendOption} style={{ height: 280 }} />
          ) : (
            <Empty description="窗口内还没有 level_* 事件" />
          )}
        </Card>
      </Space>
    </Card>
  );
}

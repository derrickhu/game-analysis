import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';

import { useAnalyticsFilter } from '../context/AnalyticsFilterContext';

const { Text } = Typography;
const { RangePicker } = DatePicker;

function defaultAttributionRange(): [Dayjs, Dayjs] {
  const yesterday = dayjs().subtract(1, 'day');
  return [yesterday.subtract(29, 'day'), yesterday];
}

interface AttributionRankingRow {
  key: string;
  provider: string;
  channel: string;
  campaign_id: string;
  adgroup_id: string;
  creative_id: string;
  users: number;
  new_users: number;
  active_user_days: number;
  d1_retained_users: number;
  d3_retained_users: number;
  d7_retained_users: number;
  d1_retention_rate: number | null;
  d3_retention_rate: number | null;
  d7_retention_rate: number | null;
  ad_show_cnt: number;
  ad_revenue_estimated_cny: number;
  avg_ltv_estimated_cny: number | null;
  tutorial_complete_users: number;
  order_deliver_users: number;
  first_ad_show_users: number;
  max_star_level: number;
}

interface AttributionResponse {
  ok: boolean;
  game_key?: string;
  from_date?: string;
  to_date?: string;
  summary?: {
    attributed_users: number;
    paid_or_known_users: number;
    organic_users: number;
    unknown_users: number;
    click_id_users: number;
    fallback_users: number;
    postback_dry_run: number;
  };
  rankings?: AttributionRankingRow[];
  quality?: Array<{ key: string; label: string; count: number; ratio: number }>;
  daily_cohorts?: Array<{
    cohort_date: string;
    new_users: number;
    paid_or_known_users: number;
    organic_users: number;
    unknown_users: number;
    click_id_users: number;
  }>;
  reengagement_summary?: {
    reengaged_users: number;
    paid_or_known_users: number;
    click_id_users: number;
    touch_events: number;
  };
  reengagement_daily?: Array<{
    touch_date: string;
    reengaged_users: number;
    paid_or_known_users: number;
    click_id_users: number;
    touch_events: number;
  }>;
  reengagement_by_provider?: Array<{
    key: string;
    provider: string;
    channel: string;
    campaign_id: string;
    adgroup_id: string;
    creative_id: string;
    reengaged_users: number;
    touch_events: number;
  }>;
  recent_touchpoints?: Array<Record<string, unknown>>;
  recent_postbacks?: Array<Record<string, unknown>>;
  code?: string;
  error?: string;
}

function yuan(value: number | null | undefined, precision = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '-';
  return `¥${Number(value).toFixed(precision)}`;
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatDate(range: [Dayjs, Dayjs]): { fromDate: string; toDate: string } {
  return {
    fromDate: range[0].format('YYYY-MM-DD'),
    toDate: range[1].format('YYYY-MM-DD'),
  };
}

function shortJson(value: unknown): string {
  if (!value) return '-';
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  try {
    const json = JSON.stringify(value);
    return json.length > 160 ? `${json.slice(0, 160)}...` : json;
  } catch {
    return String(value);
  }
}

export function AttributionPage() {
  const { gameKey, refreshToken, setLastRefreshedAt } = useAnalyticsFilter();
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultAttributionRange);
  const [data, setData] = useState<AttributionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const requestSeqRef = useRef(0);

  const dates = useMemo(() => formatDate(range), [range]);
  const includesToday = useMemo(() => {
    const today = dayjs().startOf('day');
    const from = range[0].startOf('day');
    const to = range[1].startOf('day');
    return !today.isBefore(from, 'day') && !today.isAfter(to, 'day');
  }, [range]);

  const load = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        game: gameKey,
        from_date: dates.fromDate,
        to_date: dates.toDate,
      });
      const res = await fetch(`/api/realtime/attribution?${params.toString()}`);
      const json = (await res.json()) as AttributionResponse;
      if (seq !== requestSeqRef.current) return;
      if (!json.ok) {
        message.error(`加载广告归因失败：${json.error || json.code}`);
      }
      setData(json);
      setLastRefreshedAt(Date.now());
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      message.error(`加载广告归因失败：${String(error)}`);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [dates.fromDate, dates.toDate, gameKey, setLastRefreshedAt]);

  useEffect(() => {
    void load();
  }, [gameKey, refreshToken, load]);

  const handleRecompute = useCallback(async () => {
    setRecomputing(true);
    try {
      const res = await fetch('/api/realtime/recompute-attribution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game: gameKey,
          from_date: dates.fromDate,
          to_date: dates.toDate,
        }),
      });
      const json = await res.json() as { ok: boolean; error?: string; code?: string; user_daily_rows?: number; postback_rows?: number };
      if (!json.ok) {
        message.error(`归因回算失败：${json.error || json.code}`);
        return;
      }
      message.success(`归因回算完成：日表 ${json.user_daily_rows || 0} 行，dry-run 回传 ${json.postback_rows || 0} 条`);
      await load();
    } catch (error) {
      message.error(`归因回算请求失败：${String(error)}`);
    } finally {
      setRecomputing(false);
    }
  }, [dates.fromDate, dates.toDate, gameKey, load]);

  const rankingColumns: ColumnsType<AttributionRankingRow> = [
    {
      title: '来源',
      dataIndex: 'provider',
      key: 'provider',
      width: 120,
      render: (v: string, row) => (
        <Space direction="vertical" size={0}>
          <Tag color={v === 'organic' ? 'default' : v === 'unknown' ? 'orange' : 'blue'}>{v || 'unknown'}</Tag>
          <Text type="secondary">{row.channel || '-'}</Text>
        </Space>
      ),
    },
    { title: 'Campaign', dataIndex: 'campaign_id', key: 'campaign_id', ellipsis: true, width: 160, render: (v: string) => v || '-' },
    { title: 'Adgroup', dataIndex: 'adgroup_id', key: 'adgroup_id', ellipsis: true, width: 160, render: (v: string) => v || '-' },
    { title: 'Creative', dataIndex: 'creative_id', key: 'creative_id', ellipsis: true, width: 160, render: (v: string) => v || '-' },
    { title: '期间新增', dataIndex: 'new_users', key: 'new_users', align: 'right', sorter: (a, b) => a.new_users - b.new_users },
    { title: '用户', dataIndex: 'users', key: 'users', align: 'right', sorter: (a, b) => a.users - b.users },
    { title: 'D1', dataIndex: 'd1_retention_rate', key: 'd1', align: 'right', render: percent },
    { title: 'D3', dataIndex: 'd3_retention_rate', key: 'd3', align: 'right', render: percent },
    { title: 'D7', dataIndex: 'd7_retention_rate', key: 'd7', align: 'right', render: percent },
    { title: '人均LTV', dataIndex: 'avg_ltv_estimated_cny', key: 'ltv', align: 'right', render: (v) => yuan(v, 4) },
    { title: '广告收入', dataIndex: 'ad_revenue_estimated_cny', key: 'revenue', align: 'right', render: (v) => yuan(v) },
    { title: '教程完成', dataIndex: 'tutorial_complete_users', key: 'tutorial', align: 'right' },
    { title: '首广告用户', dataIndex: 'first_ad_show_users', key: 'adUser', align: 'right' },
    { title: '最高等级', dataIndex: 'max_star_level', key: 'star', align: 'right' },
  ];

  const touchpointColumns: ColumnsType<Record<string, unknown>> = [
    { title: '时间', dataIndex: 'event_ts', key: 'event_ts', width: 170, render: (v) => v ? new Date(Number(v)).toLocaleString('zh-CN') : '-' },
    { title: '用户', dataIndex: 'user_key', key: 'user_key', ellipsis: true, width: 180 },
    { title: '来源', dataIndex: 'provider', key: 'provider', width: 120 },
    { title: 'Campaign', dataIndex: 'campaign_id', key: 'campaign_id', ellipsis: true },
    { title: '点击标识', dataIndex: 'click_id', key: 'click_id', ellipsis: true, render: (v, r) => String(v || r.gdt_vid || '-') },
    { title: 'scene', dataIndex: 'launch_scene', key: 'launch_scene', width: 90 },
    { title: 'raw', dataIndex: 'raw_json', key: 'raw', ellipsis: true, render: shortJson },
  ];

  const postbackColumns: ColumnsType<Record<string, unknown>> = [
    { title: '事件', dataIndex: 'event_name', key: 'event_name', width: 150 },
    { title: '平台', dataIndex: 'platform', key: 'platform', width: 120 },
    { title: '状态', dataIndex: 'status', key: 'status', width: 100, render: (v) => <Tag>{String(v)}</Tag> },
    { title: '用户', dataIndex: 'user_key', key: 'user_key', ellipsis: true, width: 180 },
    { title: 'dedupe', dataIndex: 'dedupe_key', key: 'dedupe_key', ellipsis: true },
    { title: 'payload', dataIndex: 'payload_json', key: 'payload', ellipsis: true, render: shortJson },
  ];

  const summary = data?.summary;
  const rankings = data?.rankings || [];
  const dailyCohorts = data?.daily_cohorts || [];
  const reSummary = data?.reengagement_summary;
  const reengagementDaily = data?.reengagement_daily || [];
  const reengagementByProvider = data?.reengagement_by_provider || [];

  const dailyColumns: ColumnsType<(typeof dailyCohorts)[number]> = [
    { title: '注册日', dataIndex: 'cohort_date', key: 'cohort_date', width: 120 },
    { title: '新增', dataIndex: 'new_users', key: 'new_users', align: 'right', sorter: (a, b) => a.new_users - b.new_users },
    { title: '非自然量', dataIndex: 'paid_or_known_users', key: 'paid', align: 'right' },
    { title: '自然量', dataIndex: 'organic_users', key: 'organic', align: 'right' },
    { title: '未知', dataIndex: 'unknown_users', key: 'unknown', align: 'right' },
    { title: '带点击标识', dataIndex: 'click_id_users', key: 'click', align: 'right' },
  ];

  const reDailyColumns: ColumnsType<(typeof reengagementDaily)[number]> = [
    { title: '触达日', dataIndex: 'touch_date', key: 'touch_date', width: 120 },
    { title: '回流用户', dataIndex: 'reengaged_users', key: 'users', align: 'right' },
    { title: '腾讯广告', dataIndex: 'paid_or_known_users', key: 'paid', align: 'right' },
    { title: '带点击标识', dataIndex: 'click_id_users', key: 'click', align: 'right' },
    { title: '触达次数', dataIndex: 'touch_events', key: 'events', align: 'right' },
  ];

  const reProviderColumns: ColumnsType<(typeof reengagementByProvider)[number]> = [
    {
      title: '来源',
      dataIndex: 'provider',
      key: 'provider',
      width: 120,
      render: (v: string, row) => (
        <Space direction="vertical" size={0}>
          <Tag color={v === 'organic' ? 'default' : v === 'unknown' ? 'orange' : 'blue'}>{v || 'unknown'}</Tag>
          <Text type="secondary">{row.channel || '-'}</Text>
        </Space>
      ),
    },
    { title: 'Campaign', dataIndex: 'campaign_id', key: 'campaign_id', ellipsis: true, render: (v: string) => v || '-' },
    { title: 'Adgroup', dataIndex: 'adgroup_id', key: 'adgroup_id', ellipsis: true, render: (v: string) => v || '-' },
    { title: 'Creative', dataIndex: 'creative_id', key: 'creative_id', ellipsis: true, render: (v: string) => v || '-' },
    { title: '回流用户', dataIndex: 'reengaged_users', key: 'users', align: 'right' },
    { title: '触达次数', dataIndex: 'touch_events', key: 'events', align: 'right' },
  ];

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Card title="分析范围">
        <Space wrap>
          <RangePicker
            allowClear={false}
            value={range}
            format="YYYY-MM-DD"
            disabledDate={(date) => !date || date.isAfter(dayjs(), 'day')}
            onChange={(value) => {
              if (!value || !value[0] || !value[1]) return;
              const days = value[1].startOf('day').diff(value[0].startOf('day'), 'day') + 1;
              if (days > 60) {
                message.warning('广告归因一次最多看 60 天');
                return;
              }
              setRange([value[0], value[1]] as [Dayjs, Dayjs]);
            }}
            presets={[
              { label: '今天', value: [dayjs().startOf('day'), dayjs().startOf('day')] as [Dayjs, Dayjs] },
              { label: '近 7 天（含今天）', value: [dayjs().subtract(6, 'day'), dayjs()] as [Dayjs, Dayjs] },
              { label: '近 14 天（含今天）', value: [dayjs().subtract(13, 'day'), dayjs()] as [Dayjs, Dayjs] },
              { label: '近 30 天（至昨天）', value: defaultAttributionRange() },
            ]}
          />
          <Text type="secondary">
            按注册 cohort 筛选。投流当天请选「今天」；数据需先「立即拉取」再「回算归因」。D1/D7 看今天 cohort 会不完整，属正常。
          </Text>
        </Space>
      </Card>

      <Card
        title="拉新归因（按注册 cohort · 首期 dry-run）"
        extra={
          <Space>
            <Text type="secondary">{dates.fromDate} ~ {dates.toDate}</Text>
            <Button onClick={() => void load()} loading={loading}>刷新</Button>
            <Button type="primary" onClick={handleRecompute} loading={recomputing}>
              回算归因 + 生成 dry-run
            </Button>
          </Space>
        }
      >
        <Alert
          showIcon
          type="info"
          message="当前页用于验证归因采集、用户绑定和深层事件回传候选；真实广告平台回传默认不开启。"
          description={
            includesToday
              ? '范围含今天：适合投流当天看新增来源与「带点击标识」是否正常；请先顶部「立即拉取」再点「回算归因」。下方「最近启动触点」不依赖日期，可实时看 campaign/click_id。'
              : '上方 KPI 与下表均按「分析范围」内的注册 cohort 统计，不是全游戏历史存量。'
          }
          style={{ marginBottom: 16 }}
        />
        <Row gutter={[16, 16]}>
          <Col xs={12} md={4}>
            <Statistic title="期间新增（拉新）" value={summary?.attributed_users || 0} />
          </Col>
          <Col xs={12} md={4}><Statistic title="非自然量" value={summary?.paid_or_known_users || 0} /></Col>
          <Col xs={12} md={4}><Statistic title="自然量" value={summary?.organic_users || 0} /></Col>
          <Col xs={12} md={4}><Statistic title="未知来源" value={summary?.unknown_users || 0} /></Col>
          <Col xs={12} md={4}><Statistic title="带点击标识" value={summary?.click_id_users || 0} /></Col>
          <Col xs={12} md={4}><Statistic title="期间 dry-run 回传" value={summary?.postback_dry_run || 0} /></Col>
        </Row>
      </Card>

      <Card title="拉新：每日新增归因（按注册日）" loading={loading && !data}>
        {dailyCohorts.length > 0 ? (
          <Table
            rowKey="cohort_date"
            size="small"
            columns={dailyColumns}
            dataSource={dailyCohorts}
            pagination={{ pageSize: 15, showSizeChanger: true }}
          />
        ) : (
          <Empty description="所选日期范围内暂无注册 cohort。可扩大范围或先执行「回算归因」。" />
        )}
      </Card>

      <Card
        title="回流归因（按广告触达日 · 老用户再营销）"
        loading={loading && !data}
      >
        <Alert
          showIcon
          type="warning"
          message="回流 ≠ 拉新：仅统计注册日之前的老用户，在触达日当天经腾讯广告参数（gdt_vid/click_id）再次启动。"
          description="不含 referrer_app、分享等小程序跳转。6/4 若只有跳转无广告参数，修正后不会出现在此表。需先回算归因。"
          style={{ marginBottom: 16 }}
        />
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}><Statistic title="期间回流用户" value={reSummary?.reengaged_users || 0} /></Col>
          <Col xs={12} md={6}><Statistic title="腾讯广告触达" value={reSummary?.paid_or_known_users || 0} /></Col>
          <Col xs={12} md={6}><Statistic title="带点击标识" value={reSummary?.click_id_users || 0} /></Col>
          <Col xs={12} md={6}><Statistic title="触达次数" value={reSummary?.touch_events || 0} /></Col>
        </Row>
        {reengagementDaily.length > 0 ? (
          <Table
            rowKey="touch_date"
            size="small"
            columns={reDailyColumns}
            dataSource={reengagementDaily}
            pagination={{ pageSize: 10 }}
            style={{ marginBottom: 16 }}
          />
        ) : (
          <Empty
            description="所选范围内暂无老用户广告触达。扩大日期或确认投流后已拉取并回算。"
            style={{ marginBottom: 16 }}
          />
        )}
        {reengagementByProvider.length > 0 ? (
          <Table
            rowKey="key"
            size="small"
            columns={reProviderColumns}
            dataSource={reengagementByProvider}
            scroll={{ x: 900 }}
            pagination={{ pageSize: 10 }}
          />
        ) : null}
      </Card>

      <Card title="拉新：Campaign / Adgroup / Creative 质量排行" loading={loading && !data}>
        {rankings.length > 0 ? (
          <Table
            rowKey="key"
            size="small"
            columns={rankingColumns}
            dataSource={rankings}
            scroll={{ x: 1500 }}
            pagination={{ pageSize: 20 }}
          />
        ) : (
          <Empty description="暂无归因聚合数据。先回算归因，或在开发者工具用 mock query 启动后拉取事件。" />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="最近启动触点（调试）">
            <Table
              rowKey={(row) => String(row.touch_id || row.event_ts)}
              size="small"
              columns={touchpointColumns}
              dataSource={data?.recent_touchpoints || []}
              pagination={{ pageSize: 8 }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="回传 dry-run 队列">
            <Table
              rowKey={(row) => String(row.id || row.dedupe_key)}
              size="small"
              columns={postbackColumns}
              dataSource={data?.recent_postbacks || []}
              pagination={{ pageSize: 8 }}
            />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

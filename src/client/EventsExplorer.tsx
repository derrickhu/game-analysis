import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Empty, Input, Select, Space, Table, Tag, Typography } from 'antd';

import { appendPlatformQuery, type PlatformFilter } from '../shared/platforms';
import { type WindowValue, buildWindowQuery } from './timeWindow';

/**
 * 原始事件浏览组件
 *
 * 接全局 gameKey / windowSel / refreshToken；不维护自己的时间窗口和刷新节奏。
 *
 * 提供能力：
 * - 按事件名精确过滤（下拉，选项来自当前窗口内 distinct event_name）
 * - 按 user_id / anonymous_id 模糊搜索
 * - 分页（默认 50 条/页，最大 500）
 * - 行展开：以 JSON tree 展示完整 envelope，便于排查与二次分析
 *
 * 数据源：/api/realtime/events，后端从 SQLite analytics_events 直查。
 */

const { Text } = Typography;

interface AnalyticsEventRow {
  event_id: string;
  event_name: string;
  event_ts: number;
  ingest_ts: number;
  game_key: string;
  app_version: string;
  sdk_version: string;
  platform: string;
  user_id: string;
  anonymous_id: string;
  session_id: string;
  session_seq: number;
  device_brand: string;
  device_model: string;
  device_system: string;
  device_screen_w: number;
  device_screen_h: number;
  device_network: string;
  params_json: string;
  ingested_at: number;
}

interface EventsResponse {
  ok: boolean;
  total?: number;
  events?: AnalyticsEventRow[];
  query?: { game_key: string; from: string; to: string; limit: number; offset: number };
  error?: string;
}

interface EventNamesResponse {
  ok: boolean;
  names?: string[];
}

interface EventsExplorerProps {
  fixedGameKey: string;
  platform: PlatformFilter;
  windowSel: WindowValue;
  refreshToken: number;
}

/** 用 user_id / anonymous_id 中较合适的展示出来 */
function formatUserKey(row: AnalyticsEventRow): { primary: string; tag: 'user' | 'anon' } {
  if (row.user_id) return { primary: row.user_id, tag: 'user' };
  return { primary: row.anonymous_id, tag: 'anon' };
}

function formatTs(ts: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 给 event_name 上色，让广告/关卡/会话三类一眼能区分开 */
function eventColor(name: string): string {
  if (name.startsWith('ad_')) return 'orange';
  if (name.startsWith('level_')) return 'purple';
  if (name === 'session_start' || name === 'session_end') return 'blue';
  if (name === 'login') return 'green';
  return 'default';
}

export function EventsExplorer(props: EventsExplorerProps): ReactElement {
  const { fixedGameKey: gameKey, platform, windowSel, refreshToken } = props;
  const [data, setData] = useState<EventsResponse | null>(null);
  const [eventNames, setEventNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [eventNameFilter, setEventNameFilter] = useState<string | undefined>(undefined);
  const [userQuery, setUserQuery] = useState('');
  const [pagination, setPagination] = useState({ current: 1, pageSize: 50 });

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const winQs = appendPlatformQuery(buildWindowQuery(windowSel), platform);
      const params = new URLSearchParams();
      params.set('game', gameKey);
      if (eventNameFilter) params.set('event_name', eventNameFilter);
      if (userQuery.trim()) params.set('user_query', userQuery.trim());
      params.set('limit', String(pagination.pageSize));
      params.set('offset', String((pagination.current - 1) * pagination.pageSize));
      const res = await fetch(`/api/realtime/events?${winQs}&${params.toString()}`);
      const json = (await res.json()) as EventsResponse;
      setData(json);
    } catch (err) {
      console.warn('[events] load failed', err);
    } finally {
      setLoading(false);
    }
  }, [gameKey, platform, windowSel, eventNameFilter, userQuery, pagination.current, pagination.pageSize]);

  const loadEventNames = useCallback(async () => {
    try {
      const winQs = appendPlatformQuery(buildWindowQuery(windowSel), platform);
      const res = await fetch(`/api/realtime/event-names?game=${encodeURIComponent(gameKey)}&${winQs}`);
      const json = (await res.json()) as EventNamesResponse;
      if (json.ok && json.names) setEventNames(json.names);
    } catch (err) {
      console.warn('[events] load names failed', err);
    }
  }, [gameKey, platform, windowSel]);

  useEffect(() => {
    void loadData();
    void loadEventNames();
  }, [loadData, loadEventNames, refreshToken]);

  // 切换游戏 / 平台 / 时间窗口 / 筛选时回到第 1 页（保持 pageSize 不变）
  useEffect(() => {
    setPagination((prev) => ({ ...prev, current: 1 }));
  }, [gameKey, platform, windowSel, eventNameFilter, userQuery]);

  const columns = useMemo(
    () => [
      {
        title: '时间',
        dataIndex: 'event_ts',
        key: 'event_ts',
        width: 180,
        render: (v: number) => <Text style={{ fontSize: 12 }}>{formatTs(v)}</Text>,
      },
      {
        title: '事件名',
        dataIndex: 'event_name',
        key: 'event_name',
        width: 140,
        render: (v: string) => <Tag color={eventColor(v)}>{v}</Tag>,
      },
      {
        title: '用户',
        key: 'user',
        width: 280,
        render: (_: unknown, row: AnalyticsEventRow) => {
          const { primary, tag } = formatUserKey(row);
          return (
            <Space size={4}>
              <Tag color={tag === 'user' ? 'geekblue' : 'default'}>
                {tag === 'user' ? 'user' : 'anon'}
              </Tag>
              <Text code copyable={{ text: primary }} style={{ fontSize: 12 }}>
                {primary}
              </Text>
            </Space>
          );
        },
      },
      {
        title: '平台',
        dataIndex: 'platform',
        key: 'platform',
        width: 80,
      },
      {
        title: '会话',
        key: 'session',
        width: 200,
        render: (_: unknown, row: AnalyticsEventRow) => (
          <Space size={4}>
            <Text type="secondary" style={{ fontSize: 12 }}>seq:{row.session_seq}</Text>
            <Text code style={{ fontSize: 11 }}>{row.session_id.slice(0, 8)}…</Text>
          </Space>
        ),
      },
      {
        title: '主要参数',
        dataIndex: 'params_json',
        key: 'params',
        ellipsis: true,
        render: (v: string) => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(v) || {};
          } catch {
            return <Text type="secondary">-</Text>;
          }
          // 摘 4 个最常见字段在表格里展示，完整 JSON 在展开行里看
          const preview = ['scene', 'ad_type', 'level_id', 'completed', 'reason', 'entry']
            .filter((k) => k in parsed)
            .map((k) => `${k}=${JSON.stringify(parsed[k])}`)
            .join(', ');
          return (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {preview || '(展开看完整 JSON)'}
            </Text>
          );
        },
      },
    ],
    [],
  );

  return (
    <Card
      title={(
        <Space>
          <span>原始事件流</span>
          <Tag>共 {data?.total ?? 0} 条</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            数据源：analytics_events（SQLite），按 event_ts 倒序
          </Text>
        </Space>
      )}
      extra={(
        <Space wrap>
          <Select
            allowClear
            placeholder="筛选事件名"
            value={eventNameFilter}
            onChange={(v) => setEventNameFilter(v)}
            options={eventNames.map((n) => ({ value: n, label: n }))}
            style={{ width: 180 }}
          />
          <Input.Search
            placeholder="搜 user_id / anon_id"
            allowClear
            value={userQuery}
            onChange={(e) => setUserQuery(e.target.value)}
            onSearch={() => setPagination((p) => ({ ...p, current: 1 }))}
            style={{ width: 260 }}
          />
        </Space>
      )}
    >
      <Table<AnalyticsEventRow>
        rowKey="event_id"
        size="small"
        loading={loading}
        dataSource={data?.events || []}
        columns={columns as never}
        locale={{ emptyText: <Empty description="窗口内暂无事件" /> }}
        pagination={{
          current: pagination.current,
          pageSize: pagination.pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200],
          showTotal: (total) => `共 ${total} 条`,
          onChange: (current, pageSize) => setPagination({ current, pageSize }),
        }}
        scroll={{ x: 1200 }}
        expandable={{
          expandedRowRender: (row) => {
            let parsed: unknown = {};
            try {
              parsed = JSON.parse(row.params_json);
            } catch {
              parsed = { __raw: row.params_json };
            }
            const envelope = {
              event_id: row.event_id,
              event_name: row.event_name,
              event_ts: row.event_ts,
              event_ts_local: formatTs(row.event_ts),
              ingest_ts: row.ingest_ts,
              ingest_ts_local: formatTs(row.ingest_ts),
              game_key: row.game_key,
              app_version: row.app_version,
              sdk_version: row.sdk_version,
              platform: row.platform,
              user_id: row.user_id,
              anonymous_id: row.anonymous_id,
              session_id: row.session_id,
              session_seq: row.session_seq,
              device: {
                brand: row.device_brand,
                model: row.device_model,
                system: row.device_system,
                sdk_version: row.sdk_version,
                screen_w: row.device_screen_w,
                screen_h: row.device_screen_h,
                network: row.device_network,
              },
              params: parsed,
            };
            return (
              <pre
                style={{
                  margin: 0,
                  padding: 12,
                  backgroundColor: '#f5f5f5',
                  borderRadius: 4,
                  fontSize: 12,
                  overflowX: 'auto',
                  maxHeight: 400,
                }}
              >
                {JSON.stringify(envelope, null, 2)}
              </pre>
            );
          },
        }}
      />
    </Card>
  );
}

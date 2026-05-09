import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Button, Card, Col, Descriptions, Empty, message, Modal, Row, Space, Table, Tag, Tooltip, Typography,
} from 'antd';

const { Title } = Typography;

/**
 * 系统运维面板：与具体游戏无关的全局功能。
 *
 * 设计原则：
 * - 不接受 gameKey / windowSel 参数：这里展示的都是经分平台自身的运行状态
 *   （上报 cron、事件清理 cron、数据库容量等），切换游戏不应影响这一页的内容
 * - 自己管理 refreshToken：用户在 Tab 内可主动刷新；不跟随顶部 5 分钟自动刷新（避免争抢）
 * - 后续扩展会放进来：CloudBase 容量监控、SDK 错误日报、告警配置、ECPM 配置管理 等
 *
 * 与 RealtimeAdRevenue 的"上报系统健康度"卡片相比，这里：
 * - 不再传 gameKey 给 /api/realtime/health → 后端返回所有已接入游戏的运行记录聚合视图
 * - 把"事件清理任务"从广告视图里搬过来，避免切游戏时重复展示同一份系统状态
 */

interface CleanupRunRow {
  id: number;
  started_at: number;
  finished_at: number;
  trigger_source: string;
  dry_run: number;
  retention_days_local: number;
  retention_days_cloud: number;
  cutoff_local_ms: number;
  cutoff_cloud_ms: number;
  local_deleted: number;
  cloud_deleted: number;
  cloud_errors: string;
  status: string;
  duration_ms: number;
}

interface CleanupNowResponse {
  ok: true;
  retentionDaysLocal: number;
  retentionDaysCloud: number;
  cutoffLocalMs: number;
  cutoffCloudMs: number;
  localDeleted: number;
  cloudDeleted: number;
  cloudErrors: string[];
  dryRun: boolean;
  triggerSource: string;
  durationMs: number;
}

interface HealthResponse {
  ok: true;
  games: Array<{ game_key: string; display_name: string; cloud_env: string }>;
  stats: {
    totalEvents: number;
    last24hEvents: number;
    oldestEventTs: number | null;
    newestEventTs: number | null;
  };
  recent_runs: Array<{
    id: number;
    game_key: string;
    started_at: number;
    finished_at: number;
    status: string;
    fetched: number;
    cursor_before: number;
    cursor_after: number;
    error_message: string;
  }>;
}

function formatNumber(value: number): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '0';
  return Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '0';
}

function formatTs(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN');
}

export function SystemOpsPanel(): ReactElement {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [cleanupRuns, setCleanupRuns] = useState<CleanupRunRow[]>([]);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const loadHealth = useCallback(async () => {
    try {
      // 不传 game：拉「所有已接入游戏」聚合视图，符合"系统运维"语义
      const res = await fetch('/api/realtime/health');
      const json = (await res.json()) as HealthResponse | { ok: false };
      if ('ok' in json && json.ok) {
        setHealth(json);
      }
    } catch (err) {
      console.warn('[system-ops] load health failed', err);
    }
  }, []);

  const loadCleanupRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/realtime/cleanup-history?limit=10');
      const json = (await res.json()) as { ok: true; runs: CleanupRunRow[] } | { ok: false };
      if ('ok' in json && json.ok) {
        setCleanupRuns(json.runs);
      }
    } catch (err) {
      console.warn('[system-ops] load cleanup history failed', err);
    }
  }, []);

  const triggerCleanup = useCallback(
    async (dryRun: boolean): Promise<void> => {
      setCleanupBusy(true);
      try {
        const res = await fetch('/api/realtime/cleanup-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dry_run: dryRun }),
        });
        const json = (await res.json()) as CleanupNowResponse | { ok: false; error?: string };
        if ('ok' in json && json.ok) {
          const msg = dryRun
            ? `预演完成：本地将删 ${json.localDeleted}，云端将删 ${json.cloudDeleted}（不真删）`
            : `清理完成：本地删了 ${json.localDeleted}，云端删了 ${json.cloudDeleted}`;
          if (json.cloudErrors.length > 0) {
            message.warning(`${msg}；告警 ${json.cloudErrors.length} 条`);
            console.warn('[cleanup-now] cloud errors:', json.cloudErrors);
          } else {
            message.success(msg);
          }
        } else {
          const errMsg = (json as { error?: string }).error || '未知错误';
          message.error(`清理失败：${errMsg}`);
        }
      } catch (err) {
        message.error(`清理请求失败：${(err as Error).message}`);
      } finally {
        setCleanupBusy(false);
        await loadCleanupRuns();
      }
    },
    [loadCleanupRuns],
  );

  useEffect(() => {
    void loadHealth();
    void loadCleanupRuns();
  }, [loadHealth, loadCleanupRuns, refreshTick]);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <span>
            事件清理任务{' '}
            <Tooltip
              title={
                <div style={{ maxWidth: 380, fontSize: 12, lineHeight: 1.6 }}>
                  双 retention：本地保留 90 天（D7 留存 + 历史回看）/ 云端保留 7 天（CloudBase 配额省钱）
                  <br />
                  自动 cron 每天 03:00 跑一次；手动按钮可随时触发。
                  <br />
                  <b>仅清理 analytics_events 集合 / 表</b>，由白名单守卫强制锁死，不可能误删玩家数据。
                  <br />
                  第一次跑或不放心时请用「dry-run 预演」，不真删，只显示将要删多少。
                </div>
              }
            >
              <Tag color="cyan" style={{ cursor: 'help' }}>每日 03:00 ⓘ</Tag>
            </Tooltip>
          </span>
        }
        extra={
          <Space>
            <Button size="small" onClick={() => void triggerCleanup(true)} loading={cleanupBusy}>
              dry-run 预演
            </Button>
            <Button
              size="small"
              danger
              loading={cleanupBusy}
              onClick={() => {
                Modal.confirm({
                  title: '确认立即清理过期事件？',
                  content: (
                    <div style={{ fontSize: 13 }}>
                      这会真实删除 <b>本地 90 天前</b> 与 <b>云端 7 天前</b> 的事件数据。
                      <br />
                      仅命中 <code>analytics_events</code>，玩家数据库不受影响。
                      <br />
                      建议先点「dry-run 预演」确认数量后再执行。
                    </div>
                  ),
                  okText: '确认清理',
                  okButtonProps: { danger: true },
                  cancelText: '取消',
                  onOk: () => triggerCleanup(false),
                });
              }}
            >
              立即清理
            </Button>
            <Button size="small" onClick={() => setRefreshTick((t) => t + 1)}>刷新</Button>
          </Space>
        }
      >
        {cleanupRuns.length > 0 ? (
          <Table
            size="small"
            rowKey="id"
            columns={[
              {
                title: '触发',
                dataIndex: 'trigger_source',
                key: 'trigger_source',
                width: 80,
                render: (v: string) => (
                  <Tag color={v === 'cron' ? 'blue' : 'purple'}>{v === 'cron' ? '自动' : '手动'}</Tag>
                ),
              },
              {
                title: '类型',
                dataIndex: 'dry_run',
                key: 'dry_run',
                width: 80,
                render: (v: number) => (v ? <Tag>预演</Tag> : <Tag color="red">真删</Tag>),
              },
              {
                title: '状态',
                dataIndex: 'status',
                key: 'status',
                width: 80,
                render: (v: string) => (
                  <Tag color={v === 'success' ? 'green' : v === 'partial' ? 'orange' : 'red'}>{v}</Tag>
                ),
              },
              {
                title: (
                  <Tooltip title="本地 MySQL 删除条数（保留 90 天前）">
                    <span>本地</span>
                  </Tooltip>
                ),
                dataIndex: 'local_deleted',
                key: 'local_deleted',
                width: 80,
                render: (v: number) => formatNumber(v),
              },
              {
                title: (
                  <Tooltip title="云端 CloudDB 删除条数（保留 7 天前），所有游戏合计">
                    <span>云端</span>
                  </Tooltip>
                ),
                dataIndex: 'cloud_deleted',
                key: 'cloud_deleted',
                width: 80,
                render: (v: number) => formatNumber(v),
              },
              {
                title: '保留',
                key: 'retention',
                width: 110,
                render: (_: unknown, row: CleanupRunRow) => (
                  <span style={{ fontSize: 12 }}>
                    本地 {row.retention_days_local}d / 云 {row.retention_days_cloud}d
                  </span>
                ),
              },
              {
                title: '耗时',
                dataIndex: 'duration_ms',
                key: 'duration_ms',
                width: 80,
                render: (v: number) => `${(v / 1000).toFixed(1)}s`,
              },
              {
                title: '完成时间',
                dataIndex: 'finished_at',
                key: 'finished_at',
                width: 170,
                render: (v: number) => formatTs(v),
              },
              {
                title: '错误',
                dataIndex: 'cloud_errors',
                key: 'cloud_errors',
                ellipsis: { showTitle: false },
                render: (v: string) => {
                  if (!v) return <Typography.Text type="secondary">-</Typography.Text>;
                  let parsed: string[] = [];
                  try {
                    parsed = JSON.parse(v);
                  } catch {
                    parsed = [v];
                  }
                  return (
                    <Tooltip title={parsed.join('\n')}>
                      <Tag color="red">{parsed.length} 条</Tag>
                    </Tooltip>
                  );
                },
              },
            ]}
            dataSource={cleanupRuns}
            pagination={{ pageSize: 5 }}
            scroll={{ x: 'max-content' }}
          />
        ) : (
          <Empty description="尚无清理记录。点右上「dry-run 预演」可立即触发一次（不真删）" />
        )}
      </Card>

      <Card
        size="small"
        title="上报系统健康度"
        extra={
          <Button size="small" onClick={() => setRefreshTick((t) => t + 1)}>刷新</Button>
        }
      >
        {health ? (
          <Row gutter={16}>
            <Col span={12}>
              <Descriptions column={1} size="small" title="本地数据库">
                <Descriptions.Item label="本地事件总数（全游戏）">
                  {formatNumber(health.stats.totalEvents)}
                </Descriptions.Item>
                <Descriptions.Item label="近 24h 新增">
                  {formatNumber(health.stats.last24hEvents)}
                </Descriptions.Item>
                <Descriptions.Item label="最早事件">{formatTs(health.stats.oldestEventTs)}</Descriptions.Item>
                <Descriptions.Item label="最新事件">{formatTs(health.stats.newestEventTs)}</Descriptions.Item>
                <Descriptions.Item label="已接入游戏">
                  {health.games.length > 0
                    ? health.games.map((g) => (
                        <Tag key={g.game_key} color="geekblue">{g.display_name}（{g.game_key}）</Tag>
                      ))
                    : <Typography.Text type="secondary">尚无</Typography.Text>}
                </Descriptions.Item>
              </Descriptions>
            </Col>
            <Col span={12}>
              <Title level={5}>最近 cron 拉取（全游戏聚合）</Title>
              <Table
                size="small"
                rowKey="id"
                columns={[
                  {
                    title: '游戏',
                    dataIndex: 'game_key',
                    key: 'game_key',
                    width: 80,
                    render: (v: string) => <Tag color="geekblue">{v}</Tag>,
                  },
                  {
                    title: '状态',
                    dataIndex: 'status',
                    key: 'status',
                    width: 70,
                    render: (v: string) => <Tag color={v === 'success' ? 'green' : 'red'}>{v}</Tag>,
                  },
                  {
                    title: '拉取条数',
                    dataIndex: 'fetched',
                    key: 'fetched',
                    width: 90,
                    render: (v: number) => formatNumber(v),
                  },
                  {
                    title: '完成时间',
                    dataIndex: 'finished_at',
                    key: 'finished_at',
                    render: (v: number) => formatTs(v),
                  },
                ]}
                dataSource={health.recent_runs}
                pagination={{ pageSize: 5 }}
              />
            </Col>
          </Row>
        ) : (
          <Empty description="健康度未加载" />
        )}
      </Card>
    </Space>
  );
}

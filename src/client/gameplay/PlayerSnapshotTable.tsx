import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Card,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import type { FilterValue, SorterResult } from 'antd/es/table/interface';

import { formatInt } from './utils';

const { Text } = Typography;

interface PlayerListItem {
  user_id: string;
  platform: string;
  level: number;
  star: number;
  huayuan: number;
  diamond: number;
  stamina: number;
  flower_sign_tickets: number;
  tutorial_step: number;
  tutorial_completed: 0 | 1;
  total_merges: number;
  total_orders: number;
  checkin_total_days: number;
  checkin_streak_days: number;
  unlocked_deco_count: number;
  collection_discovered_count: number;
  affinity_card_owned_count: number;
  active_customer_count: number;
  last_active_at: number;
}

interface ListResponse {
  ok: boolean;
  items?: PlayerListItem[];
  total?: number;
  page?: number;
  page_size?: number;
  query?: { snapshot_date: string };
  code?: string;
  error?: string;
}

interface PlayerSnapshotTableProps {
  gameKey: string;
  /** 由父组件传入的快照日期；切换日期时整张表会重新拉 */
  snapshotDate: string;
  /** 父组件「立即拉取」完成后会 +1，子组件感知到刷新即可重拉 */
  refreshNonce?: number;
}

type SortOrder = 'asc' | 'desc';

interface TableState {
  page: number;
  pageSize: number;
  sortKey: string;
  sortOrder: SortOrder;
  // 高级筛选
  platform: string;       // '' = 不过滤；'wx' / 'h5' / 'dy' / 'anon'
  tutorialCompleted: 0 | 1 | null;
  minLevel: number | null;
  maxLevel: number | null;
  minHuayuan: number | null;
  // 关键字搜索（独立 state，避免每次按键都触发 fetch；按 Enter 提交）
  userIdSearch: string;
}

const DEFAULT_STATE: TableState = {
  page: 1,
  pageSize: 50,
  sortKey: 'last_active_at',
  sortOrder: 'desc',
  platform: '',
  tutorialCompleted: null,
  minLevel: null,
  maxLevel: null,
  minHuayuan: null,
  userIdSearch: '',
};

/** Antd Table sorter.columnKey → 后端 sort 字段 */
const COLUMN_KEY_TO_SORT: Record<string, string> = {
  level: 'level',
  star: 'star',
  huayuan: 'huayuan',
  diamond: 'diamond',
  stamina: 'stamina',
  flower_sign_tickets: 'flower_sign_tickets',
  total_merges: 'total_merges',
  total_orders: 'total_orders',
  tutorial: 'tutorial_step',
  unlocked_deco_count: 'unlocked_deco_count',
  collection_discovered_count: 'collection_discovered_count',
  affinity_card_owned_count: 'affinity_card_owned_count',
  checkin_total_days: 'checkin_total_days',
  checkin_streak_days: 'checkin_streak_days',
  last_active_at: 'last_active_at',
};

/** user_id 形如 'wx:xxx' / 'h5:xxx'，提取前缀 */
function platformOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx > 0 ? userId.slice(0, idx) : '';
}

function formatTs(ts: number): string {
  if (!ts || ts <= 0) return '-';
  return new Date(ts).toLocaleString('zh-CN');
}

/**
 * 玩家明细表格：服务端排序 + 受控筛选 + 分页 + user_id 关键字搜索。
 *
 * 设计要点：
 *   1. 全部 sorter / filter 走服务端（filteredValue / sortOrder 受控），
 *      避免客户端只对当前页排序导致的"全表第 N 名 vs 当前页第 N 名"歧义
 *   2. user_id 搜索独立成一个 Input，按 Enter 提交，不在每次按键时打后端
 *   3. 数值过滤（min_level / min_huayuan）放在表格上方的工具条里，
 *      因为 Antd 列头 filterDropdown 写起来很重，独立工具条更清晰
 */
export function PlayerSnapshotTable({ gameKey, snapshotDate, refreshNonce = 0 }: PlayerSnapshotTableProps) {
  const [state, setState] = useState<TableState>(DEFAULT_STATE);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  // searchInput 与 state.userIdSearch 分离：输入时只更新 input，按 Enter 才下沉到 state 并触发 fetch
  const [searchInput, setSearchInput] = useState('');
  const requestSeqRef = useRef(0);

  const fetchData = useCallback(
    async (s: TableState, date: string) => {
      if (!date) {
        setData(null);
        return;
      }
      const seq = ++requestSeqRef.current;
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set('game', gameKey);
        params.set('date', date);
        params.set('sort', s.sortKey);
        params.set('order', s.sortOrder);
        params.set('page', String(s.page));
        params.set('pageSize', String(s.pageSize));
        if (s.userIdSearch) params.set('q', s.userIdSearch);
        if (s.platform) params.set('platform', s.platform);
        if (s.tutorialCompleted === 0 || s.tutorialCompleted === 1) {
          params.set('tutorialCompleted', String(s.tutorialCompleted));
        }
        if (s.minLevel !== null) params.set('minLevel', String(s.minLevel));
        if (s.maxLevel !== null) params.set('maxLevel', String(s.maxLevel));
        if (s.minHuayuan !== null) params.set('minHuayuan', String(s.minHuayuan));

        const res = await fetch(`/api/realtime/huahua-snapshot/players?${params.toString()}`);
        const json = (await res.json()) as ListResponse;
        if (seq !== requestSeqRef.current) return;
        if (!json.ok) {
          message.error(`查询玩家明细失败：${json.error || json.code}`);
        }
        setData(json);
      } catch (error) {
        if (seq !== requestSeqRef.current) return;
        message.error(`加载玩家明细失败：${String(error)}`);
      } finally {
        if (seq === requestSeqRef.current) setLoading(false);
      }
    },
    [gameKey],
  );

  useEffect(() => {
    void fetchData(state, snapshotDate);
  }, [state, snapshotDate, refreshNonce, fetchData]);

  const items = data?.items || [];
  const total = data?.total || 0;

  // ---- Antd Table onChange: 把 pagination/sorter/filters 翻译成 state ----
  const handleTableChange = useCallback(
    (
      pagination: TablePaginationConfig,
      filters: Record<string, FilterValue | null>,
      sorter: SorterResult<PlayerListItem> | SorterResult<PlayerListItem>[],
    ) => {
      const s = Array.isArray(sorter) ? sorter[0] : sorter;
      const next: TableState = { ...state };

      // 分页
      const newPage = pagination.current ?? 1;
      const newPageSize = pagination.pageSize ?? state.pageSize;
      next.pageSize = newPageSize;
      next.page = newPageSize !== state.pageSize ? 1 : newPage;

      // 排序：清空 sorter 时回退到最近活跃 desc（默认稳定排序）
      if (s && s.order && s.columnKey && COLUMN_KEY_TO_SORT[String(s.columnKey)]) {
        next.sortKey = COLUMN_KEY_TO_SORT[String(s.columnKey)] || 'last_active_at';
        next.sortOrder = s.order === 'ascend' ? 'asc' : 'desc';
      } else {
        next.sortKey = 'last_active_at';
        next.sortOrder = 'desc';
      }

      // 列头筛选
      const platformFilter = filters.platform?.[0];
      next.platform = typeof platformFilter === 'string' ? platformFilter : '';

      const tcFilter = filters.tutorial?.[0];
      next.tutorialCompleted =
        tcFilter === 1 || tcFilter === '1' ? 1 : tcFilter === 0 || tcFilter === '0' ? 0 : null;

      // 任意筛选 / 排序变化 → 回到第 1 页（避免第 5 页换条件结果空）
      if (
        next.platform !== state.platform ||
        next.tutorialCompleted !== state.tutorialCompleted ||
        next.sortKey !== state.sortKey ||
        next.sortOrder !== state.sortOrder
      ) {
        next.page = 1;
      }

      setState(next);
    },
    [state],
  );

  // 工具条上的高级筛选改变 → 回第 1 页
  const updateFilter = useCallback(
    (patch: Partial<TableState>) => {
      setState((prev) => ({ ...prev, ...patch, page: 1 }));
    },
    [],
  );

  const submitSearch = useCallback(() => {
    updateFilter({ userIdSearch: searchInput.trim() });
  }, [searchInput, updateFilter]);

  const resetAll = useCallback(() => {
    setSearchInput('');
    setState(DEFAULT_STATE);
  }, []);

  // ---- columns ----
  const columns = useMemo<ColumnsType<PlayerListItem>>(
    () => [
      {
        title: '用户ID',
        dataIndex: 'user_id',
        key: 'user_id',
        width: 240,
        fixed: 'left',
        ellipsis: { showTitle: false },
        render: (v: string) => (
          <Tooltip title={v} placement="topLeft">
            <Text code style={{ fontSize: 12 }}>
              {v}
            </Text>
          </Tooltip>
        ),
      },
      {
        title: '平台',
        key: 'platform',
        width: 90,
        filters: [
          { text: 'wx (微信)', value: 'wx' },
          { text: 'h5', value: 'h5' },
          { text: 'dy (抖音)', value: 'dy' },
          { text: 'anon (匿名)', value: 'anon' },
        ],
        filterMultiple: false,
        filteredValue: state.platform ? [state.platform] : null,
        render: (_: unknown, r: PlayerListItem) => platformOf(r.user_id) || r.platform || '-',
      },
      {
        title: '星级',
        dataIndex: 'level',
        key: 'level',
        width: 80,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'level' ? (state.sortOrder === 'asc' ? 'ascend' : 'descend') : null,
        render: (v: number) => `Lv.${v}`,
      },
      {
        title: '累计星',
        dataIndex: 'star',
        key: 'star',
        width: 90,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'star' ? (state.sortOrder === 'asc' ? 'ascend' : 'descend') : null,
        render: formatInt,
      },
      {
        title: '花愿',
        dataIndex: 'huayuan',
        key: 'huayuan',
        width: 100,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'huayuan' ? (state.sortOrder === 'asc' ? 'ascend' : 'descend') : null,
        render: formatInt,
      },
      {
        title: '钻石',
        dataIndex: 'diamond',
        key: 'diamond',
        width: 90,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'diamond' ? (state.sortOrder === 'asc' ? 'ascend' : 'descend') : null,
        render: formatInt,
      },
      {
        title: '体力',
        dataIndex: 'stamina',
        key: 'stamina',
        width: 80,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'stamina' ? (state.sortOrder === 'asc' ? 'ascend' : 'descend') : null,
        render: formatInt,
      },
      {
        title: '许愿券',
        dataIndex: 'flower_sign_tickets',
        key: 'flower_sign_tickets',
        width: 90,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'flower_sign_tickets'
            ? state.sortOrder === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
        render: formatInt,
      },
      {
        title: '累计合成',
        dataIndex: 'total_merges',
        key: 'total_merges',
        width: 110,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'total_merges'
            ? state.sortOrder === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
        render: formatInt,
      },
      {
        title: '累计订单',
        dataIndex: 'total_orders',
        key: 'total_orders',
        width: 100,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'total_orders'
            ? state.sortOrder === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
        render: formatInt,
      },
      {
        title: '教程',
        key: 'tutorial',
        width: 140,
        sorter: true,
        sortOrder:
          state.sortKey === 'tutorial_step'
            ? state.sortOrder === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
        filters: [
          { text: '已完成', value: 1 },
          { text: '引导中', value: 0 },
        ],
        filterMultiple: false,
        filteredValue:
          state.tutorialCompleted === 1
            ? [1]
            : state.tutorialCompleted === 0
              ? [0]
              : null,
        render: (_: unknown, r: PlayerListItem) =>
          r.tutorial_completed === 1 ? (
            <Tag color="green">已完成 (Step {r.tutorial_step})</Tag>
          ) : (
            <Tag color="orange">Step {r.tutorial_step}</Tag>
          ),
      },
      {
        title: '装饰解锁',
        dataIndex: 'unlocked_deco_count',
        key: 'unlocked_deco_count',
        width: 110,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'unlocked_deco_count'
            ? state.sortOrder === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
        render: formatInt,
      },
      {
        title: '图鉴发现',
        dataIndex: 'collection_discovered_count',
        key: 'collection_discovered_count',
        width: 110,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'collection_discovered_count'
            ? state.sortOrder === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
        render: formatInt,
      },
      {
        title: '熟客卡',
        dataIndex: 'affinity_card_owned_count',
        key: 'affinity_card_owned_count',
        width: 100,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'affinity_card_owned_count'
            ? state.sortOrder === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
        render: formatInt,
      },
      {
        title: '签到天数',
        dataIndex: 'checkin_total_days',
        key: 'checkin_total_days',
        width: 100,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'checkin_total_days'
            ? state.sortOrder === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
        render: formatInt,
      },
      {
        title: '连续签到',
        dataIndex: 'checkin_streak_days',
        key: 'checkin_streak_days',
        width: 100,
        align: 'right',
        sorter: true,
        sortOrder:
          state.sortKey === 'checkin_streak_days'
            ? state.sortOrder === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
        render: formatInt,
      },
      {
        title: '最近活跃',
        dataIndex: 'last_active_at',
        key: 'last_active_at',
        width: 180,
        sorter: true,
        sortOrder:
          state.sortKey === 'last_active_at'
            ? state.sortOrder === 'asc'
              ? 'ascend'
              : 'descend'
            : null,
        defaultSortOrder: 'descend',
        render: (v: number) => formatTs(v),
      },
    ],
    [state.sortKey, state.sortOrder, state.platform, state.tutorialCompleted],
  );

  const hasActiveFilter =
    state.userIdSearch ||
    state.platform ||
    state.tutorialCompleted !== null ||
    state.minLevel !== null ||
    state.maxLevel !== null ||
    state.minHuayuan !== null;

  return (
    <Card
      size="small"
      title={
        <Space>
          <span>玩家明细</span>
          <Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
            {snapshotDate || '-'} · 共 {formatInt(total)} 人
            {hasActiveFilter ? '（已筛选）' : ''}
          </Text>
        </Space>
      }
      extra={
        <Space>
          {hasActiveFilter && (
            <a onClick={resetAll}>
              <ReloadOutlined /> 重置筛选
            </a>
          )}
        </Space>
      }
    >
      <Space orientation="vertical" size="small" style={{ width: '100%' }}>
        {/* 工具条：搜索 + 高级筛选（数值范围 / 平台前缀） */}
        <Space wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索 user_id（按 Enter 提交）"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onPressEnter={submitSearch}
            onClear={() => updateFilter({ userIdSearch: '' })}
            style={{ width: 280 }}
          />
          <Tooltip title="星级范围（含两端）">
            <InputNumber
              placeholder="星级 ≥"
              min={0}
              value={state.minLevel ?? undefined}
              onChange={(v) => updateFilter({ minLevel: typeof v === 'number' ? v : null })}
              style={{ width: 110 }}
            />
          </Tooltip>
          <InputNumber
            placeholder="星级 ≤"
            min={0}
            value={state.maxLevel ?? undefined}
            onChange={(v) => updateFilter({ maxLevel: typeof v === 'number' ? v : null })}
            style={{ width: 110 }}
          />
          <Tooltip title="花愿存量下限">
            <InputNumber
              placeholder="花愿 ≥"
              min={0}
              value={state.minHuayuan ?? undefined}
              onChange={(v) => updateFilter({ minHuayuan: typeof v === 'number' ? v : null })}
              style={{ width: 130 }}
            />
          </Tooltip>
          <Select
            allowClear
            placeholder="教程完成态"
            value={state.tutorialCompleted ?? undefined}
            onChange={(v) =>
              updateFilter({
                tutorialCompleted: v === 0 || v === 1 ? (v as 0 | 1) : null,
              })
            }
            options={[
              { value: 1, label: '已完成' },
              { value: 0, label: '引导中' },
            ]}
            style={{ width: 130 }}
          />
        </Space>

        <Table<PlayerListItem>
          rowKey="user_id"
          size="small"
          loading={loading}
          dataSource={items}
          columns={columns}
          scroll={{ x: 1900 }}
          pagination={{
            current: state.page,
            pageSize: state.pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: ['20', '50', '100', '200'],
            showTotal: (t) => `共 ${formatInt(t)} 条`,
          }}
          onChange={handleTableChange}
        />
      </Space>
    </Card>
  );
}

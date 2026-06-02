import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Card,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import type { ColumnsType, TablePaginationConfig } from 'antd/es/table';
import type { FilterValue, SorterResult } from 'antd/es/table/interface';

import { formatInt } from './utils';

const { Text } = Typography;

interface HotpotPlayerListItem {
  user_id: string;
  platform: string;
  coins: number;
  coins_total_earned: number;
  coins_total_spent: number;
  bowl_badge_level: number;
  bowl_play_level_index: number;
  fruit_slice_best_score: number;
  fruit_slice_total_runs: number;
  gacha_total_pulls: number;
  bowl_tool_total: number;
  milk_tea_shop_level: number;
  milk_tea_total_clears: number;
  last_active_at: number;
}

interface ListResponse {
  ok: boolean;
  items?: HotpotPlayerListItem[];
  total?: number;
  page?: number;
  page_size?: number;
  code?: string;
  error?: string;
}

interface HotpotPlayerSnapshotTableProps {
  snapshotDate: string;
  refreshNonce?: number;
}

type SortOrder = 'asc' | 'desc';

interface TableState {
  page: number;
  pageSize: number;
  sortKey: string;
  sortOrder: SortOrder;
  platform: string;
  minCoins: number | null;
  maxCoins: number | null;
  minBowlLevel: number | null;
  userIdSearch: string;
}

const DEFAULT_STATE: TableState = {
  page: 1,
  pageSize: 50,
  sortKey: 'coins',
  sortOrder: 'desc',
  platform: '',
  minCoins: null,
  maxCoins: null,
  minBowlLevel: null,
  userIdSearch: '',
};

const COLUMN_KEY_TO_SORT: Record<string, string> = {
  coins: 'coins',
  coins_total_earned: 'coins_total_earned',
  coins_total_spent: 'coins_total_spent',
  bowl_badge_level: 'bowl_badge_level',
  fruit_slice_best_score: 'fruit_slice_best_score',
  gacha_total_pulls: 'gacha_total_pulls',
  milk_tea_shop_level: 'milk_tea_shop_level',
  last_active_at: 'last_active_at',
};

function formatActiveTime(ts: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export function HotpotPlayerSnapshotTable({ snapshotDate, refreshNonce = 0 }: HotpotPlayerSnapshotTableProps) {
  const [items, setItems] = useState<HotpotPlayerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [state, setState] = useState<TableState>(DEFAULT_STATE);
  const [searchDraft, setSearchDraft] = useState('');
  const requestSeqRef = useRef(0);

  const fetchList = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        game: 'hotpot',
        date: snapshotDate,
        sort: state.sortKey,
        order: state.sortOrder,
        page: String(state.page),
        pageSize: String(state.pageSize),
      });
      if (state.userIdSearch) params.set('q', state.userIdSearch);
      if (state.platform) params.set('platform', state.platform);
      if (state.minCoins != null) params.set('minCoins', String(state.minCoins));
      if (state.maxCoins != null) params.set('maxCoins', String(state.maxCoins));
      if (state.minBowlLevel != null) params.set('minBowlLevel', String(state.minBowlLevel));

      const res = await fetch(`/api/realtime/huahua-snapshot/players?${params.toString()}`);
      const json = (await res.json()) as ListResponse;
      if (seq !== requestSeqRef.current) return;
      if (!json.ok) {
        message.error(`加载玩家明细失败：${json.error || json.code}`);
        return;
      }
      setItems(json.items || []);
      setTotal(json.total || 0);
    } catch (error) {
      if (seq !== requestSeqRef.current) return;
      message.error(`加载玩家明细失败：${String(error)}`);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [snapshotDate, state]);

  useEffect(() => {
    if (!snapshotDate || snapshotDate === '-') return;
    void fetchList();
  }, [snapshotDate, refreshNonce, fetchList]);

  const columns: ColumnsType<HotpotPlayerListItem> = useMemo(
    () => [
      {
        title: '用户 ID',
        dataIndex: 'user_id',
        key: 'user_id',
        width: 200,
        ellipsis: true,
        render: (v: string) => <Text copyable={{ text: v }}>{v}</Text>,
      },
      {
        title: '平台',
        dataIndex: 'platform',
        key: 'platform',
        width: 72,
        render: (v: string) => <Tag>{v || 'unknown'}</Tag>,
      },
      {
        title: '金币',
        dataIndex: 'coins',
        key: 'coins',
        width: 100,
        sorter: true,
        align: 'right',
        render: (v: number) => <Text strong>{formatInt(v)}</Text>,
      },
      {
        title: '累计获得',
        dataIndex: 'coins_total_earned',
        key: 'coins_total_earned',
        width: 100,
        sorter: true,
        align: 'right',
        render: formatInt,
      },
      {
        title: '累计花费',
        dataIndex: 'coins_total_spent',
        key: 'coins_total_spent',
        width: 100,
        sorter: true,
        align: 'right',
        render: formatInt,
      },
      {
        title: '主线通关',
        dataIndex: 'bowl_badge_level',
        key: 'bowl_badge_level',
        width: 90,
        sorter: true,
        align: 'right',
        render: (v: number) => `第 ${v} 关`,
      },
      {
        title: '果切最高分',
        dataIndex: 'fruit_slice_best_score',
        key: 'fruit_slice_best_score',
        width: 110,
        sorter: true,
        align: 'right',
        render: formatInt,
      },
      {
        title: '扭蛋次数',
        dataIndex: 'gacha_total_pulls',
        key: 'gacha_total_pulls',
        width: 90,
        sorter: true,
        align: 'right',
        render: formatInt,
      },
      {
        title: '奶茶店等级',
        dataIndex: 'milk_tea_shop_level',
        key: 'milk_tea_shop_level',
        width: 100,
        sorter: true,
        align: 'right',
        render: (v: number) => `Lv.${v}`,
      },
      {
        title: '最后活跃',
        dataIndex: 'last_active_at',
        key: 'last_active_at',
        width: 160,
        sorter: true,
        render: formatActiveTime,
      },
    ],
    [],
  );

  const onTableChange = (
    pagination: TablePaginationConfig,
    _filters: Record<string, FilterValue | null>,
    sorter: SorterResult<HotpotPlayerListItem> | SorterResult<HotpotPlayerListItem>[],
  ) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const nextPage = pagination.current || 1;
    const nextPageSize = pagination.pageSize || 50;
    let sortKey = state.sortKey;
    let sortOrder: SortOrder = state.sortOrder;
    if (s?.columnKey && s.order) {
      const mapped = COLUMN_KEY_TO_SORT[String(s.columnKey)];
      if (mapped) {
        sortKey = mapped;
        sortOrder = s.order === 'ascend' ? 'asc' : 'desc';
      }
    }
    setState((prev) => ({
      ...prev,
      page: nextPage,
      pageSize: nextPageSize,
      sortKey,
      sortOrder,
    }));
  };

  return (
    <Card
      size="small"
      title="玩家明细（可排序 / 筛选 / 搜索）"
      extra={<Text type="secondary">共 {formatInt(total)} 人</Text>}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Input
          prefix={<SearchOutlined />}
          placeholder="搜索 user_id"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onPressEnter={() => setState((p) => ({ ...p, page: 1, userIdSearch: searchDraft.trim() }))}
          style={{ width: 220 }}
          allowClear
        />
        <Select
          placeholder="平台"
          allowClear
          style={{ width: 100 }}
          value={state.platform || undefined}
          onChange={(v) => setState((p) => ({ ...p, page: 1, platform: v || '' }))}
          options={[
            { value: 'wx', label: '微信' },
            { value: 'h5', label: 'H5' },
            { value: 'anon', label: '匿名' },
          ]}
        />
        <InputNumber
          placeholder="金币 ≥"
          min={0}
          value={state.minCoins ?? undefined}
          onChange={(v) => setState((p) => ({ ...p, page: 1, minCoins: v ?? null }))}
        />
        <InputNumber
          placeholder="金币 ≤"
          min={0}
          value={state.maxCoins ?? undefined}
          onChange={(v) => setState((p) => ({ ...p, page: 1, maxCoins: v ?? null }))}
        />
        <InputNumber
          placeholder="主线通关 ≥"
          min={0}
          value={state.minBowlLevel ?? undefined}
          onChange={(v) => setState((p) => ({ ...p, page: 1, minBowlLevel: v ?? null }))}
        />
      </Space>

      <Table
        rowKey="user_id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={items}
        scroll={{ x: 1100 }}
        pagination={{
          current: state.page,
          pageSize: state.pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: ['20', '50', '100', '200'],
          showTotal: (t) => `共 ${t} 条`,
        }}
        onChange={onTableChange}
      />
    </Card>
  );
}

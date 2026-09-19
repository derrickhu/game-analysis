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

import { platformToSnapshotPrefix, type PlatformFilter } from '../../shared/platforms';

import { formatInt } from './utils';

const { Text } = Typography;

interface PetTowerPlayerListItem {
  user_id: string;
  platform: string;
  coins: number;
  lingyu: number;
  tickets: number;
  stamina: number;
  owned_pet_count: number;
  max_pet_level: number;
  max_pet_star: number;
  recruited_count: number;
  stage_clear_count: number;
  max_chapter: number;
  tower_best_floor: number;
  checkin_total_days: number;
  tutorial_home_done: number;
  tutorial_drag_done: number;
  sidebar_claimed: number;
  last_active_at: number;
}

interface ListResponse {
  ok: boolean;
  items?: PetTowerPlayerListItem[];
  total?: number;
  page?: number;
  page_size?: number;
  code?: string;
  error?: string;
}

interface PetTowerPlayerSnapshotTableProps {
  snapshotDate: string;
  globalPlatform?: PlatformFilter;
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
  minClears: number | null;
  minTowerFloor: number | null;
  userIdSearch: string;
}

const DEFAULT_STATE: TableState = {
  page: 1,
  pageSize: 50,
  sortKey: 'stage_clear_count',
  sortOrder: 'desc',
  platform: '',
  minCoins: null,
  maxCoins: null,
  minClears: null,
  minTowerFloor: null,
  userIdSearch: '',
};

const COLUMN_KEY_TO_SORT: Record<string, string> = {
  coins: 'coins',
  lingyu: 'lingyu',
  owned_pet_count: 'owned_pet_count',
  max_pet_level: 'max_pet_level',
  stage_clear_count: 'stage_clear_count',
  max_chapter: 'max_chapter',
  tower_best_floor: 'tower_best_floor',
  checkin_total_days: 'checkin_total_days',
  last_active_at: 'last_active_at',
};

function formatActiveTime(ts: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function yesNo(v: number): string {
  return v ? '是' : '否';
}

export function PetTowerPlayerSnapshotTable({
  snapshotDate,
  globalPlatform = 'wechat',
  refreshNonce = 0,
}: PetTowerPlayerSnapshotTableProps) {
  const [items, setItems] = useState<PetTowerPlayerListItem[]>([]);
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
        game: 'petTower',
        date: snapshotDate,
        sort: state.sortKey,
        order: state.sortOrder,
        page: String(state.page),
        pageSize: String(state.pageSize),
      });
      if (state.userIdSearch) params.set('q', state.userIdSearch);
      const effectivePlatform = state.platform || platformToSnapshotPrefix(globalPlatform);
      if (effectivePlatform) params.set('platform', effectivePlatform);
      if (state.minCoins != null) params.set('minCoins', String(state.minCoins));
      if (state.maxCoins != null) params.set('maxCoins', String(state.maxCoins));
      if (state.minClears != null) params.set('minClears', String(state.minClears));
      if (state.minTowerFloor != null) params.set('minTowerFloor', String(state.minTowerFloor));

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
  }, [snapshotDate, state, globalPlatform]);

  useEffect(() => {
    if (!snapshotDate || snapshotDate === '-') return;
    void fetchList();
  }, [snapshotDate, refreshNonce, fetchList]);

  const columns: ColumnsType<PetTowerPlayerListItem> = useMemo(
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
        title: '灵宠币',
        dataIndex: 'coins',
        key: 'coins',
        width: 90,
        sorter: true,
        align: 'right',
        render: (v: number) => <Text strong>{formatInt(v)}</Text>,
      },
      {
        title: '灵玉',
        dataIndex: 'lingyu',
        key: 'lingyu',
        width: 80,
        sorter: true,
        align: 'right',
        render: formatInt,
      },
      {
        title: '灵宠数',
        dataIndex: 'owned_pet_count',
        key: 'owned_pet_count',
        width: 80,
        sorter: true,
        align: 'right',
        render: formatInt,
      },
      {
        title: '最高宠等',
        dataIndex: 'max_pet_level',
        key: 'max_pet_level',
        width: 90,
        sorter: true,
        align: 'right',
        render: (v: number) => `Lv.${v}`,
      },
      {
        title: '主线通关',
        dataIndex: 'stage_clear_count',
        key: 'stage_clear_count',
        width: 90,
        sorter: true,
        align: 'right',
        render: formatInt,
      },
      {
        title: '最高章',
        dataIndex: 'max_chapter',
        key: 'max_chapter',
        width: 80,
        sorter: true,
        align: 'right',
        render: (v: number) => (v > 0 ? `第 ${v} 章` : '-'),
      },
      {
        title: '通天塔',
        dataIndex: 'tower_best_floor',
        key: 'tower_best_floor',
        width: 80,
        sorter: true,
        align: 'right',
        render: (v: number) => (v > 0 ? `${v} 层` : '-'),
      },
      {
        title: '签到天数',
        dataIndex: 'checkin_total_days',
        key: 'checkin_total_days',
        width: 90,
        sorter: true,
        align: 'right',
        render: formatInt,
      },
      {
        title: '主页引导',
        dataIndex: 'tutorial_home_done',
        key: 'tutorial_home_done',
        width: 80,
        render: yesNo,
      },
      {
        title: '侧边栏',
        dataIndex: 'sidebar_claimed',
        key: 'sidebar_claimed',
        width: 70,
        render: yesNo,
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
    sorter: SorterResult<PetTowerPlayerListItem> | SorterResult<PetTowerPlayerListItem>[],
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
          style={{ width: 110 }}
          value={state.platform || undefined}
          onChange={(v) => setState((p) => ({ ...p, page: 1, platform: v || '' }))}
          options={[
            { value: 'wx', label: '微信' },
            { value: 'dy', label: '抖音' },
            { value: 'tap', label: 'TapTap' },
            { value: 'hw', label: '华为' },
          ]}
        />
        <InputNumber
          placeholder="灵宠币 ≥"
          min={0}
          value={state.minCoins ?? undefined}
          onChange={(v) => setState((p) => ({ ...p, page: 1, minCoins: v ?? null }))}
        />
        <InputNumber
          placeholder="灵宠币 ≤"
          min={0}
          value={state.maxCoins ?? undefined}
          onChange={(v) => setState((p) => ({ ...p, page: 1, maxCoins: v ?? null }))}
        />
        <InputNumber
          placeholder="通关 ≥"
          min={0}
          value={state.minClears ?? undefined}
          onChange={(v) => setState((p) => ({ ...p, page: 1, minClears: v ?? null }))}
        />
        <InputNumber
          placeholder="通天塔 ≥"
          min={0}
          value={state.minTowerFloor ?? undefined}
          onChange={(v) => setState((p) => ({ ...p, page: 1, minTowerFloor: v ?? null }))}
        />
      </Space>

      <Table
        rowKey="user_id"
        size="small"
        loading={loading}
        columns={columns}
        dataSource={items}
        scroll={{ x: 1280 }}
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

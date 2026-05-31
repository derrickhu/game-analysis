import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Tooltip, Typography,
} from 'antd';
import ReactECharts from 'echarts-for-react';

import {
  defaultSeriesZoomStart,
  formatSeriesBucketLabel,
  SERIES_GRANULARITY_LABEL,
  SeriesGranularitySwitch,
  type SeriesGranularity,
} from './SeriesGranularitySwitch';
import { type WindowValue, buildWindowQuery } from './timeWindow';

// 顶部 App.tsx 全局选择器统一管控：gameKey、windowSel（时间窗口）、refreshToken（手动刷新计数）
// 都从 props 传入，子组件不再持有任何独立筛选器，避免「上面选 today、卡片右上角又是 1h」的混淆
//
// 与本游戏无关的全局功能（事件清理任务 / 上报系统健康度等）已抽离到 SystemOpsPanel.tsx，
// 由顶部 Tab 切换显示，避免业务面板里塞过多运维信息

interface AdSeriesItem {
  minute: string;
  ad_request_cnt: number;
  ad_show_cnt: number;
  ad_click_cnt: number;
  ad_complete_cnt: number;
  ad_error_cnt: number;
  ad_revenue_estimated_cny: number;
  // 桶级用户视角指标（plan p0 趋势化）
  ad_uau: number;
  dau: number;
  ad_show_per_uu: number;
  ad_penetration_rate: number;
  arpdau_estimated_cny: number;
}

interface AdSummary {
  game_key: string;
  from: string;
  to: string;
  total_show: number;
  total_click: number;
  total_complete: number;
  total_request: number;
  total_error: number;
  total_revenue_estimated_cny: number;
  ctr: number;
  completion_rate: number;
  avg_ecpm_cny: number;
  // 用户维度（plan p0 新增）
  ad_uau: number;
  dau: number;
  ad_penetration_rate: number;
  ad_show_per_uu: number;
  arpdau_estimated_cny: number;
  // 漏斗维度（plan p0 新增）
  fill_rate: number;
  error_rate: number;
}

interface AdBreakdown {
  ad_type: string;
  scene: string;
  ad_request_cnt: number;
  ad_show_cnt: number;
  ad_click_cnt: number;
  ad_complete_cnt: number;
  ad_error_cnt: number;
  ad_revenue_estimated_cny: number;
  ecpm_cny: number;
}

interface AdRevenueResponse {
  ok: true;
  estimated: boolean;
  notice: string;
  query: { game_key: string; from: string; to: string; window_minutes: number };
  summary: AdSummary;
  series: AdSeriesItem[];
  /** 小时桶 series：字段同 5 分钟桶，仅给「关键变现指标趋势」长尺度对比图用 */
  series_hourly: AdSeriesItem[];
  /** 天桶 series：字段同 5 分钟桶，给跨日走势使用 */
  series_daily: AdSeriesItem[];
  breakdown_by_scene: AdBreakdown[];
}

/**
 * 广告错误明细 Top N。
 *
 * err_code 列里 -100/-101 是 SDK 自定义码（unavailable / busy）；
 * 其它都是 wx 真实 errCode：常见 -1 cgi fail（流量主网关临时故障）、1004 no advertisement（无广告主出价）、
 * 1005 ad init failed（账号未配齐）。
 */
interface AdErrorRow {
  scene: string;
  ad_type: string;
  err_code: string;
  err_msg: string;
  count: number;
  affected_users: number;
  last_seen_ts: number;
  /** 该行实际包含的所有 err_code（双发时是 ['-1','-102']，正常情况只有一个） */
  merged_err_codes: string[];
  /** 是否检测到 SDK 双发：'-102' 包装码与真实码同 err_msg 且次数相等，已合并去重 */
  is_dual_emit: boolean;
}

interface AdErrorsResponse {
  ok: true;
  query: { game_key: string; from: string; to: string; window_minutes: number; limit: number };
  total_errors: number;
  errors: AdErrorRow[];
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '0';
}

function formatTs(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN');
}

/**
 * 各游戏广告场景中文名映射。
 * key 与客户端打点的 scene 字段保持一致，便于经分人员一眼读懂场景含义。
 * 命名规范：玩法子模式用前缀分组（如「果切无尽 - xxx」），同游戏不同 Scene 一眼可分。
 * 兼容历史/拼写差异：unlock_next_order_place（旧拼写）与 unlock_next_order_plate 同义。
 */
const SCENE_LABELS: Record<string, Record<string, string>> = {
  hotpot: {
    // === BowlScene 主玩法（关卡型，按 levelId 推进） ===
    level_fail_revive: '关卡失败复活',
    tool_help_free: '关卡道具免费使用',
    unlock_next_order_plate: '解锁下一个订单碟',
    unlock_next_order_place: '解锁下一个订单碟',
    // === CatalogScene 图鉴 ===
    // 进入图鉴时触发的插屏广告，微信原生频控（默认 1 次/分钟 + 新用户保护期），无需业务节流
    catalog_open: '图鉴页插屏',
    // === HomeScene 首页福利入口 ===
    // 首页关卡里程碑礼包，用户看激励视频累计进度后领取礼包奖励。
    home_milestone_gift_ad: '首页里程碑礼包 - 领取进度广告',
    // === FruitSliceEndlessScene 果切无尽（独立挑战玩法） ===
    // 客户端 UI 标题对照见 src/scenes/FruitSliceEndlessScene.ts
    fruit_slice_revive: '果切无尽 - 局内复活',
    fruit_slice_remove_pipe_block: '果切无尽 - 移除管道木板',
    fruit_slice_tool_eliminate: '果切无尽 - 消除道具',
    fruit_slice_tool_shuffle: '果切无尽 - 打乱道具',
    fruit_slice_checkpoint_start: '果切无尽 - 从档位开始',
    // === DailyLimitedScene 每日限定 ===
    daily_limited_tool_lift: '每日限定 - 暂存水果移出',
    daily_limited_tool_shuffle: '每日限定 - 洗牌道具',
    daily_limited_tool_undo: '每日限定 - 撤销上一步',
    daily_limited_unlock_buffer_slot: '每日限定 - 解锁额外暂存格',
  },
  // huahua 的广告位定义见 game2D_huahua/src/managers/AdManager.ts 的 AdScene 枚举
  huahua: {
    // 主玩法激励位
    stamina_recover: '体力恢复',
    cd_speedup: '建筑 CD 加速',
    merch_shop: '商店广告购买',
    board_cell_unlock: '订单板格子解锁',
    warehouse_slot_unlock: '仓库格子解锁',
    special_deco_unlock: '特殊装饰解锁',
    promo_furniture_unlock: '宣传款家具解锁',
    merge_bubble_unlock: '合成气泡解锁',
    // 福利/日常位
    merch_daily_refresh: '商品每日刷新',
    flower_sign_daily_draw: '许愿券每日抽',
    warehouse_organize: '仓库整理',
    reward_box_organize: '奖励箱整理',
    checkin_ad_bonus: '签到加餐',
  },
  caizhu: {
    level_prop_colorBlast: '闯关道具 - 同色爆破',
    level_prop_crossClear: '闯关道具 - 十字清场',
    level_prop_wildNext: '闯关道具 - 万能预备',
    classic_native_template: '经典模式 - 原生模板广告',
  },
};

/**
 * 广告错误码 → 中文说明。
 *
 * 常见来源：
 * - 负数（-100/-101）：SDK 自定义码，业务侧场景
 * - -1：wx 流量主网关 cgi fail，常出现在弱网或微信侧短时故障
 * - 1004：广告主无出价/无广告填充，IAA 常态化现象，长期看 70-80% 填充就健康
 * - 1005：广告组件初始化失败，多见于账号未配齐或 SDK 版本太旧
 * - 1100/1101：素材/上下文已过期，需重新 load
 */
const AD_ERR_CODE_LABELS: Record<string, string> = {
  '-1': '流量主 cgi 失败',
  '-100': 'SDK 不可用',
  '-101': 'SDK 调用冲突',
  '1000': '后台配置错误',
  '1004': '无广告填充',
  '1005': '广告组件初始化失败',
  '1100': '广告已过期',
  '1101': '上下文异常',
};

function getAdErrCodeLabel(code: string): string {
  if (!code) return '未知';
  return AD_ERR_CODE_LABELS[code] || (code.startsWith('-') ? '业务侧错误' : '微信侧其它');
}

function getSceneLabel(gameKey: string, scene: string): string {
  return SCENE_LABELS[gameKey]?.[scene] ?? '-';
}

/**
 * KPI 卡片同高 + 弹性布局，参考 App.tsx 留存区的写法。
 * minHeight 选 110 与 overview 留存卡保持一致，整页两块 KPI 视觉高度对齐。
 */
const kpiCardStyle = { width: '100%', height: '100%' } as const;
const kpiCardStyles = {
  body: {
    minHeight: 110,
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'space-between' as const,
  },
};

interface RealtimeAdRevenueProps {
  /** 必填：当前选中的游戏（由 App 顶部全局选择器决定），本组件随之刷新 */
  fixedGameKey: string;
  /** 必填：全局时间窗口（由 App 顶部 Select 决定） */
  windowSel: WindowValue;
  /** 必填：每点击一次顶部刷新就 +1，子组件 useEffect 依赖它来重新拉数据 */
  refreshToken: number;
}

export function RealtimeAdRevenue(props: RealtimeAdRevenueProps): ReactElement {
  const { fixedGameKey: gameKey, windowSel, refreshToken } = props;
  const [data, setData] = useState<AdRevenueResponse | null>(null);
  const [adErrors, setAdErrors] = useState<AdErrorsResponse | null>(null);
  // 广告错误表格默认折叠为 5 行紧凑视图，避免占满屏。需要排查时再展开看完整列表。
  const [adErrorsExpanded, setAdErrorsExpanded] = useState(false);
  const [revenueGranularity, setRevenueGranularity] = useState<SeriesGranularity>('five_min');
  const [keyMetricGranularity, setKeyMetricGranularity] = useState<SeriesGranularity>('hour');

  const loadData = useCallback(async () => {
    try {
      // 'today' 每次实时算今日 00:00，跨过半夜会自动滑到新的一天
      const queryStr = buildWindowQuery(windowSel);
      const url = `/api/realtime/ad-revenue?game=${encodeURIComponent(gameKey)}&${queryStr}`;
      const res = await fetch(url);
      const json = (await res.json()) as AdRevenueResponse | { ok: false; error?: string };
      if ('ok' in json && json.ok) {
        setData(json);
      }
    } catch (err) {
      console.warn('[realtime-ad] load ad data failed', err);
    }
  }, [gameKey, windowSel]);

  const loadAdErrors = useCallback(async () => {
    try {
      const queryStr = buildWindowQuery(windowSel);
      const url = `/api/realtime/ad-errors?game=${encodeURIComponent(gameKey)}&limit=20&${queryStr}`;
      const res = await fetch(url);
      const json = (await res.json()) as AdErrorsResponse | { ok: false; error?: string };
      if ('ok' in json && json.ok) {
        setAdErrors(json);
      }
    } catch (err) {
      console.warn('[realtime-ad] load ad errors failed', err);
    }
  }, [gameKey, windowSel]);

  useEffect(() => {
    void loadData();
    void loadAdErrors();
    // refreshToken 变化即触发重新拉取（来自顶部刷新按钮 / 自动 5 分钟 timer / 立即拉取后强制刷新）
  }, [loadData, loadAdErrors, refreshToken]);

  const getSeriesByGranularity = useCallback(
    (granularity: SeriesGranularity): AdSeriesItem[] => {
      if (!data) return [];
      if (granularity === 'day') return data.series_daily || [];
      if (granularity === 'hour') return data.series_hourly || [];
      return data.series || [];
    },
    [data],
  );

  const chartOption = useMemo(() => {
    const series = getSeriesByGranularity(revenueGranularity);
    const xLabels = series.map((s) => formatSeriesBucketLabel(s.minute, revenueGranularity));
    const zoomStart = defaultSeriesZoomStart(series.length, revenueGranularity);
    return {
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? '')),
      },
      legend: {
        data: ['曝光数', '广告收益(元)'],
        top: 6,
        itemGap: 28,
        itemWidth: 18,
        itemHeight: 12,
        textStyle: { fontSize: 13, color: '#262626', fontWeight: 500 },
      },
      grid: { left: 64, right: 64, top: 56, bottom: 64 },
      dataZoom: [
        { type: 'inside' as const, start: zoomStart, end: 100 },
        { type: 'slider' as const, height: 18, bottom: 16, start: zoomStart, end: 100 },
      ],
      xAxis: {
        type: 'category' as const,
        data: xLabels,
        boundaryGap: true,
        axisLabel: { fontSize: 11, hideOverlap: true, color: '#595959' },
        axisTick: { alignWithLabel: true },
      },
      yAxis: [
        {
          type: 'value' as const,
          name: '曝光数',
          nameTextStyle: { fontSize: 12, color: '#595959', padding: [0, 24, 0, 0] },
          axisLabel: { fontSize: 11, color: '#595959' },
          minInterval: 1,
          splitLine: { lineStyle: { type: 'dashed' as const, opacity: 0.5 } },
        },
        {
          type: 'value' as const,
          name: '广告收益(元)',
          position: 'right' as const,
          nameTextStyle: { fontSize: 12, color: '#FF8A3D', padding: [0, 0, 0, 24] },
          axisLabel: { fontSize: 11, color: '#FF8A3D', formatter: (v: number) => v.toFixed(2) },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '曝光数',
          type: 'bar' as const,
          // 给柱子设最大宽度 + 高于 0 的最小高度，避免曝光数为 1 时柱子像头发丝细
          barMaxWidth: 22,
          barMinHeight: 2,
          itemStyle: { color: '#5B8FF9', borderRadius: [3, 3, 0, 0] },
          emphasis: { itemStyle: { color: '#3D7BFA' } },
          data: series.map((s) => s.ad_show_cnt),
          yAxisIndex: 0,
        },
        {
          name: '广告收益(元)',
          type: 'line' as const,
          smooth: true,
          symbol: 'circle' as const,
          symbolSize: 7,
          lineStyle: { width: 2.5, color: '#FF8A3D' },
          itemStyle: { color: '#FF8A3D' },
          areaStyle: {
            color: {
              type: 'linear' as const,
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(255, 138, 61, 0.28)' },
                { offset: 1, color: 'rgba(255, 138, 61, 0)' },
              ],
            },
          },
          data: series.map((s) => s.ad_revenue_estimated_cny),
          yAxisIndex: 1,
        },
      ],
    };
  }, [getSeriesByGranularity, revenueGranularity]);

  /**
   * 关键变现指标趋势图：3 条折线共享 1 小时桶 x 轴，分别走 3 个 y 轴。
   * - 改用小时桶而非 5 分钟桶：5 分钟桶在 24h 窗口下 288 点过密，发版前后对比看不清；小时桶 24 点正好够看
   * - 三个量纲差异大（次/人、%、元），所以分 3 个 yAxis（左 1 右 2，第二个右轴 offset 60 让数字不重叠）
   * - 桶级分母（在线 UAU）为 0 时（某小时无任何事件）派生指标显示为 0，可视为该小时无在线流量
   * - 用法：发版时刻在心里画一根竖线，前后曲线对比即可看出趋势变化
   */
  const keyRatioChartOption = useMemo(() => {
    const series = getSeriesByGranularity(keyMetricGranularity);
    const zoomStart = defaultSeriesZoomStart(series.length, keyMetricGranularity);
    const bucketLabels = series.map((s) => formatSeriesBucketLabel(s.minute, keyMetricGranularity));
    return {
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'cross' as const },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : String(v ?? '')),
      },
      legend: {
        data: ['人均广告次数', '广告渗透率(%)', 'ARPDAU(元)'],
        top: 6,
        itemGap: 28,
        itemWidth: 18,
        itemHeight: 12,
        textStyle: { fontSize: 13, color: '#262626', fontWeight: 500 },
      },
      grid: { left: 64, right: 124, top: 56, bottom: 64 },
      dataZoom: [
        { type: 'inside' as const, start: zoomStart, end: 100 },
        { type: 'slider' as const, height: 18, bottom: 16, start: zoomStart, end: 100 },
      ],
      xAxis: {
        type: 'category' as const,
        data: bucketLabels,
        boundaryGap: false,
        axisLabel: { fontSize: 11, hideOverlap: true, color: '#595959' },
        axisTick: { alignWithLabel: true },
      },
      yAxis: [
        {
          type: 'value' as const,
          name: '次/人',
          position: 'left' as const,
          nameTextStyle: { fontSize: 12, color: '#5B8FF9', padding: [0, 24, 0, 0] },
          axisLabel: { fontSize: 11, color: '#5B8FF9', formatter: (v: number) => v.toFixed(2) },
          splitLine: { lineStyle: { type: 'dashed' as const, opacity: 0.4 } },
        },
        {
          type: 'value' as const,
          name: '%',
          position: 'right' as const,
          nameTextStyle: { fontSize: 12, color: '#52C41A', padding: [0, 0, 0, 24] },
          axisLabel: { fontSize: 11, color: '#52C41A', formatter: (v: number) => v.toFixed(0) },
          splitLine: { show: false },
          // 渗透率自然落在 0~100，固定上限避免 5 分钟孤峰把另两条线压扁
          min: 0,
          max: 100,
        },
        {
          type: 'value' as const,
          name: '元',
          position: 'right' as const,
          // offset 让第二个右轴不与第一个重叠，数字读起来才清楚
          offset: 60,
          nameTextStyle: { fontSize: 12, color: '#FF8A3D', padding: [0, 0, 0, 24] },
          axisLabel: { fontSize: 11, color: '#FF8A3D', formatter: (v: number) => v.toFixed(2) },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: '人均广告次数',
          type: 'line' as const,
          smooth: true,
          symbol: 'circle' as const,
          symbolSize: 6,
          lineStyle: { width: 2.5, color: '#5B8FF9' },
          itemStyle: { color: '#5B8FF9' },
          data: series.map((s) => s.ad_show_per_uu),
          yAxisIndex: 0,
          // 桶级分母为 0 时输出 0，发版前后看是否有突变即可
          connectNulls: false,
        },
        {
          name: '广告渗透率(%)',
          type: 'line' as const,
          smooth: true,
          symbol: 'circle' as const,
          symbolSize: 6,
          lineStyle: { width: 2.5, color: '#52C41A' },
          itemStyle: { color: '#52C41A' },
          data: series.map((s) => s.ad_penetration_rate),
          yAxisIndex: 1,
        },
        {
          name: 'ARPDAU(元)',
          type: 'line' as const,
          smooth: true,
          symbol: 'circle' as const,
          symbolSize: 6,
          lineStyle: { width: 2.5, color: '#FF8A3D' },
          itemStyle: { color: '#FF8A3D' },
          data: series.map((s) => s.arpdau_estimated_cny),
          yAxisIndex: 2,
        },
      ],
    };
  }, [getSeriesByGranularity, keyMetricGranularity]);

  const breakdownColumns = [
    { title: '广告类型', dataIndex: 'ad_type', key: 'ad_type' },
    { title: '场景', dataIndex: 'scene', key: 'scene' },
    {
      title: '场景说明',
      dataIndex: 'scene',
      key: 'scene_label',
      render: (v: string) => {
        const label = getSceneLabel(gameKey, v);
        return label === '-' ? <Typography.Text type="secondary">-</Typography.Text> : label;
      },
    },
    {
      title: (
        <Tooltip title="ad_request 事件总数，广告漏斗的最上游">
          <span>请求</span>
        </Tooltip>
      ),
      dataIndex: 'ad_request_cnt',
      key: 'ad_request_cnt',
      render: (v: number) => formatNumber(v),
    },
    {
      title: '曝光',
      dataIndex: 'ad_show_cnt',
      key: 'ad_show_cnt',
      render: (v: number) => formatNumber(v),
    },
    {
      title: (
        <Tooltip title="曝光 / 请求，<80% 通常说明上游素材紧缺或频控过严；>95% 视为健康">
          <span>填充率</span>
        </Tooltip>
      ),
      key: 'fill_rate',
      // 现算：避免在 server 再开一列重复落库；request=0 时显示 -
      render: (_: unknown, row: AdBreakdown) => {
        if (!row.ad_request_cnt) return <Typography.Text type="secondary">-</Typography.Text>;
        const rate = (row.ad_show_cnt / row.ad_request_cnt) * 100;
        return `${rate.toFixed(2)}%`;
      },
    },
    {
      title: (
        <Tooltip title="ad_click 事件总数。微信小游戏 SDK 当前没有点击回调（见 analytics-sdk README），本列在小游戏环境下恒为 0；保留是为了兼容未来接入第三方广告 SDK 的游戏。">
          <span>点击</span>
        </Tooltip>
      ),
      dataIndex: 'ad_click_cnt',
      key: 'ad_click_cnt',
      render: (v: number) => formatNumber(v),
    },
    {
      title: '完播',
      dataIndex: 'ad_complete_cnt',
      key: 'ad_complete_cnt',
      render: (v: number) => formatNumber(v),
    },
    {
      title: (
        <Tooltip title="完播 / 曝光，反映本场景广告完整看完率；不参与收益估算，仅用于观察广告位健康度。">
          <span>完播率</span>
        </Tooltip>
      ),
      key: 'completion_rate',
      // 不依赖 dataIndex：直接基于 ad_show_cnt / ad_complete_cnt 现算，避免新增后端字段
      render: (_: unknown, row: AdBreakdown) => {
        if (!row.ad_show_cnt) return <Typography.Text type="secondary">-</Typography.Text>;
        const rate = (row.ad_complete_cnt / row.ad_show_cnt) * 100;
        return `${rate.toFixed(2)}%`;
      },
    },
    {
      title: (
        <Tooltip title="错误 / 请求，>5% 通常说明 SDK 或网络异常；持续偏高可联动检查打点埋点">
          <span>错误率</span>
        </Tooltip>
      ),
      key: 'error_rate',
      render: (_: unknown, row: AdBreakdown) => {
        if (!row.ad_request_cnt) return <Typography.Text type="secondary">-</Typography.Text>;
        const rate = (row.ad_error_cnt / row.ad_request_cnt) * 100;
        // 只对超过 5% 的高错误率染红，方便发行同学一眼看出异常场景
        const color = rate > 5 ? '#cf1322' : undefined;
        return <span style={{ color }}>{rate.toFixed(2)}%</span>;
      },
    },
    {
      title: (
        <Tooltip title={'按 (game.adType.scene) → (game.adType) → (game._default) → (_default.adType) → (_default) 五级回退查表得到。配置见 server/config/ecpm.ts'}>
          <span>eCPM(元/千曝光) <Tag color="purple" style={{ marginLeft: 4 }}>口径</Tag></span>
        </Tooltip>
      ),
      dataIndex: 'ecpm_cny',
      key: 'ecpm_cny',
      render: (v: number) => formatNumber(v),
    },
    {
      title: (
        <span>
          广告收益(元)
          {data?.estimated ? <Tag color="orange" style={{ marginLeft: 6 }}>估算</Tag> : <Tag color="green" style={{ marginLeft: 6 }}>真实eCPM</Tag>}
        </span>
      ),
      dataIndex: 'ad_revenue_estimated_cny',
      key: 'ad_revenue_estimated_cny',
      render: (v: number) => formatNumber(v),
    },
  ];

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="warning"
        showIcon
        message={data?.estimated ? '广告金额暂按配置 eCPM 估算' : '广告金额使用真实 eCPM 分摊'}
        description={data?.notice || '广告收益优先使用微信流量主真实 eCPM；缺少真实收入/曝光时回退配置 eCPM。'}
      />

      <Card
        size="small"
        title={`实时广告收益 · ${gameKey}`}
        extra={
          <Tooltip
            title={
              <div style={{ lineHeight: 1.7 }}>
                <div><b>广告收益 = 曝光数 ÷ 1000 × eCPM</b></div>
                <div>eCPM 优先来自微信流量主真实收入/曝光；今天未结算时用最近 14 天真实加权 eCPM 预测。</div>
                <div>只有完全没有真实流量主数据时，才回退配置表 <code>server/config/ecpm.ts</code>。</div>
                <div style={{ marginTop: 4 }}>下表「eCPM」列展示每个广告场景实际使用的口径。</div>
              </div>
            }
          >
            <Tag color="blue" style={{ cursor: 'help', fontSize: 13, padding: '2px 10px' }}>
              加权平均 eCPM ≈ ¥{(data?.summary.avg_ecpm_cny ?? 0).toFixed(2)} / 千曝光 ⓘ
            </Tag>
          </Tooltip>
        }
      >
        {/*
          KPI 卡片：3x3 共 9 张，所有卡片用同一套 styles 保持高度对齐
          - 第 1 行：漏斗维度（曝光 / 填充率 / 错误率）
          - 第 2 行：变现维度（完播率 / 广告收益 / ARPDAU）
          - 第 3 行：用户维度（看广告 UAU / 渗透率 / 人均广告次数）

          已下线指标说明：
          - CTR 与点击数：依赖 ad_click 事件，但微信小游戏 SDK 没有点击回调
            （见 packages/analytics-sdk/README.md 第 73 行），永远为 0；KPI 区下线，
            场景表格内仍保留「点击」列以兼容未来接入第三方广告 SDK 的游戏。
          - 完播数：信息与「完播率」重叠，绝对值仍在场景表格内可见。
        */}
        <Row gutter={[16, 16]} align="stretch">
          <Col xs={12} md={8} xl={8} style={{ display: 'flex' }}>
            <Card style={kpiCardStyle} styles={kpiCardStyles}>
              <Tooltip title="ad_show 事件总数（按设备/事件计数，非去重用户）">
                <Statistic title="曝光数" value={data?.summary.total_show ?? 0} />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={8} xl={8} style={{ display: 'flex' }}>
            <Card style={kpiCardStyle} styles={kpiCardStyles}>
              <Tooltip title="曝光 / 请求；上游素材库存与频控健康度。低于 80% 通常说明素材紧缺或频控过严，>95% 视为健康。">
                <Statistic title="填充率(%)" value={data?.summary.fill_rate ?? 0} precision={2} />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={8} xl={8} style={{ display: 'flex' }}>
            <Card style={kpiCardStyle} styles={kpiCardStyles}>
              <Tooltip title="错误 / 请求；高于 5% 通常说明 SDK 异常或网络故障，需联动检查打点埋点。">
                <Statistic title="错误率(%)" value={data?.summary.error_rate ?? 0} precision={2} />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={8} xl={8} style={{ display: 'flex' }}>
            <Card style={kpiCardStyle} styles={kpiCardStyles}>
              <Tooltip title="完播数 / 曝光数；激励视频整体期望 >85%">
                <Statistic title="完播率(%)" value={data?.summary.completion_rate ?? 0} precision={2} />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={8} xl={8} style={{ display: 'flex' }}>
            <Card style={kpiCardStyle} styles={kpiCardStyles}>
              <Tooltip title="曝光数 ÷ 1000 × eCPM。eCPM 优先使用微信流量主真实收入/曝光；缺失时回退配置 eCPM。">
                <Statistic
                  title={(
                    <span>
                      广告收益(元) {data?.estimated ? <Tag color="orange" style={{ marginLeft: 4 }}>估算</Tag> : <Tag color="green" style={{ marginLeft: 4 }}>真实eCPM</Tag>}
                    </span>
                  ) as unknown as string}
                  value={data?.summary.total_revenue_estimated_cny ?? 0}
                  precision={2}
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={8} xl={8} style={{ display: 'flex' }}>
            <Card style={kpiCardStyle} styles={kpiCardStyles}>
              <Tooltip title="广告收益 / DAU。收益优先使用真实 eCPM 分摊；按窗口聚合，非自然日聚合。">
                <Statistic
                  title={(
                    <span>
                      ARPDAU(元) <Tag color="orange" style={{ marginLeft: 4 }}>估算</Tag>
                    </span>
                  ) as unknown as string}
                  value={data?.summary.arpdau_estimated_cny ?? 0}
                  precision={2}
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={8} xl={8} style={{ display: 'flex' }}>
            <Card style={kpiCardStyle} styles={kpiCardStyles}>
              <Tooltip title="当前窗口内 ad_show 事件去重用户数（COUNT DISTINCT user_id || anonymous_id）">
                <Statistic title="看广告 UAU" value={data?.summary.ad_uau ?? 0} suffix="人" />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={8} xl={8} style={{ display: 'flex' }}>
            <Card style={kpiCardStyle} styles={kpiCardStyles}>
              <Tooltip title="看广告 UAU / DAU。行业参考：超休闲品类 60%~80%，>80% 通常说明广告渗透充分。">
                <Statistic
                  title="广告渗透率(%)"
                  value={data?.summary.ad_penetration_rate ?? 0}
                  precision={2}
                />
              </Tooltip>
            </Card>
          </Col>
          <Col xs={12} md={8} xl={8} style={{ display: 'flex' }}>
            <Card style={kpiCardStyle} styles={kpiCardStyles}>
              <Tooltip title="总曝光 / 看广告 UAU。行业参考：超休闲品类 6~12 次/人，普通休闲游戏 3~6 次/人；过高需警惕过度变现伤留存。">
                <Statistic
                  title="人均广告次数"
                  value={data?.summary.ad_show_per_uu ?? 0}
                  precision={2}
                  suffix="次/人"
                />
              </Tooltip>
            </Card>
          </Col>
        </Row>
      </Card>

      <Card
        size="small"
        title={`${SERIES_GRANULARITY_LABEL[revenueGranularity]}趋势 · 曝光数 vs 广告收益`}
        extra={<SeriesGranularitySwitch value={revenueGranularity} onChange={setRevenueGranularity} />}
      >
        {data && getSeriesByGranularity(revenueGranularity).length > 0 ? (
          <ReactECharts option={chartOption} style={{ height: 380 }} notMerge lazyUpdate />
        ) : (
          <Empty description="暂无数据。刚上报的事件最长延迟 5 分钟才会进入聚合" />
        )}
      </Card>

      {/*
        关键变现指标趋势：3 条折线 + 3 个 yAxis
        - 给「发版前后人均广告次数 / 渗透率 / ARPDAU 是否有变化」这种 A/B 视觉对比用
        - 数据由后端 series 项里桶级 ad_uau / dau 现算派生，桶级 DAU 可能为 0（没新 session_start）这时该桶置 0
      */}
      <Card
        size="small"
        title={`关键变现指标趋势 · ${SERIES_GRANULARITY_LABEL[keyMetricGranularity]}粒度`}
        extra={
          <Space size="small">
            <SeriesGranularitySwitch value={keyMetricGranularity} onChange={setKeyMetricGranularity} />
            <Tooltip
              title={
                <div style={{ lineHeight: 1.7 }}>
                  <div>支持 5 分钟 / 小时 / 天切换：看短期波动用 5 分钟，看发版前后用小时，看跨日趋势用天。</div>
                  <div>桶级分母用「该桶任意事件去重的在线 UAU」，保证 ad_uau ≤ 在线 UAU、渗透率 ≤ 100%。</div>
                  <div>顶部 KPI 区的窗口级渗透率 / ARPDAU 仍按 session_start DAU 计算，与总览看板同口径。</div>
                  <div>桶内无任何事件时派生指标显示为 0，可视为该桶无在线流量，非数据异常。</div>
                </div>
              }
            >
              <Tag color="blue" style={{ cursor: 'help' }}>发版对比 ⓘ</Tag>
            </Tooltip>
          </Space>
        }
      >
        {data && getSeriesByGranularity(keyMetricGranularity).length > 0 ? (
          <ReactECharts option={keyRatioChartOption} style={{ height: 320 }} notMerge lazyUpdate />
        ) : (
          <Empty description="暂无数据" />
        )}
      </Card>

      <Card size="small" title="按场景拆分">
        {data && data.breakdown_by_scene.length > 0 ? (
          <Table
            size="small"
            rowKey={(row) => `${row.ad_type}|${row.scene}`}
            columns={breakdownColumns}
            dataSource={data.breakdown_by_scene}
            pagination={false}
          />
        ) : (
          <Empty description="暂无场景维度数据" />
        )}
      </Card>

      {(() => {
        // 紧凑视图：默认只展示 Top 5 行避免占满屏；展开后展示全部（最多 20）。
        // SDK 双发已在后端折叠，行数已经天然减半，再 Top 5 就足够看核心问题。
        const allRows = adErrors?.errors || [];
        const visibleRows = adErrorsExpanded ? allRows : allRows.slice(0, 5);
        const collapsedCount = Math.max(0, allRows.length - 5);
        const totalErrors = adErrors?.total_errors ?? 0;
        const dualEmitDetected = allRows.some((r) => r.is_dual_emit);

        return (
          <Card
            size="small"
            title={
              <span>
                广告错误{' '}
                <Tooltip
                  title={
                    <div style={{ maxWidth: 380, fontSize: 12, lineHeight: 1.6 }}>
                      按 (场景, 广告类型, 错误码, 错误信息) 聚合排序，识别两类问题：
                      <br />
                      1) <b>单事故</b>：top 1 集中爆发（如 cgi fail 144 起）→ 微信侧 / 发版前后
                      <br />
                      2) <b>常态拒填</b>：err_code=1004 / no advertisement → 行业常态，可忽略
                      <br />
                      <b>SDK 双发自动合并</b>：老版本 hot-pot SDK 在错误处会同时打 -102 包装码 + 真实码两条，
                      后端已折叠为一行（次数取真实值），徽章 <Tag color="default" style={{ marginLeft: 0 }}>双发</Tag> 标识。
                      <br />
                      err_code 列：负数（-100/-101）= SDK 自定义码；其它 = 微信真实 errCode 透传
                    </div>
                  }
                >
                  <Tag color="orange" style={{ cursor: 'help' }}>排障入口 ⓘ</Tag>
                </Tooltip>
                {totalErrors > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
                    窗口内 {formatNumber(totalErrors)} 起
                    {dualEmitDetected && (
                      <Typography.Text type="warning" style={{ fontSize: 12, marginLeft: 6 }}>
                        · 含双发，已合并去重
                      </Typography.Text>
                    )}
                  </Typography.Text>
                )}
              </span>
            }
            extra={
              allRows.length > 5 && (
                <Button size="small" type="link" onClick={() => setAdErrorsExpanded((v) => !v)}>
                  {adErrorsExpanded ? '收起' : `展开看全部 ${allRows.length} 条`}
                </Button>
              )
            }
          >
            {visibleRows.length > 0 ? (
              <Table
                size="small"
                rowKey={(row) => `${row.scene}|${row.ad_type}|${row.err_code}|${row.err_msg}`}
                columns={[
                  {
                    title: '场景',
                    dataIndex: 'scene',
                    key: 'scene',
                    width: 140,
                    render: (v: string) => {
                      const label = getSceneLabel(gameKey, v);
                      return (
                        <span>
                          <code style={{ fontSize: 12 }}>{v}</code>
                          {label !== '-' && (
                            <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
                              {label}
                            </Typography.Text>
                          )}
                        </span>
                      );
                    },
                  },
                  { title: '广告类型', dataIndex: 'ad_type', key: 'ad_type', width: 90 },
                  {
                    title: '错误码',
                    key: 'err_code',
                    width: 150,
                    render: (_: unknown, row: AdErrorRow) => (
                      <span>
                        <Tag color={row.err_code.startsWith('-') ? 'default' : 'volcano'}>
                          {row.err_code || '未知'}
                        </Tag>
                        {row.is_dual_emit && (
                          <Tooltip title={`SDK 双发：原始包含 ${row.merged_err_codes.join(', ')}，次数已去重`}>
                            <Tag style={{ marginLeft: 0, fontSize: 11 }}>双发</Tag>
                          </Tooltip>
                        )}
                        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
                          {getAdErrCodeLabel(row.err_code)}
                        </Typography.Text>
                      </span>
                    ),
                  },
                  {
                    title: '错误信息',
                    dataIndex: 'err_msg',
                    key: 'err_msg',
                    ellipsis: { showTitle: true },
                    render: (msg: string) => (
                      <Tooltip title={msg}>
                        <code style={{ fontSize: 12 }}>{msg || '-'}</code>
                      </Tooltip>
                    ),
                  },
                  {
                    title: (
                      <Tooltip title="去重后的真实错误次数（双发已合并）">
                        <span>次数</span>
                      </Tooltip>
                    ),
                    dataIndex: 'count',
                    key: 'count',
                    width: 80,
                    sorter: (a: AdErrorRow, b: AdErrorRow) => a.count - b.count,
                    defaultSortOrder: 'descend',
                    render: (v: number) => formatNumber(v),
                  },
                  {
                    title: (
                      <Tooltip title="去重后受影响的玩家数（user_id / anonymous_id 归一）">
                        <span>影响人数</span>
                      </Tooltip>
                    ),
                    dataIndex: 'affected_users',
                    key: 'affected_users',
                    width: 90,
                    render: (v: number) => formatNumber(v),
                  },
                  {
                    title: '最近一次',
                    dataIndex: 'last_seen_ts',
                    key: 'last_seen_ts',
                    width: 170,
                    render: (v: number) => formatTs(v),
                  },
                ]}
                dataSource={visibleRows}
                pagination={false}
                scroll={{ x: 'max-content' }}
                footer={
                  !adErrorsExpanded && collapsedCount > 0
                    ? () => (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          仅显示 Top 5 / 共 {allRows.length} 条；点击右上「展开看全部」查看其余{' '}
                          {collapsedCount} 条
                        </Typography.Text>
                      )
                    : undefined
                }
              />
            ) : (
              <Empty description="窗口内暂无广告错误，是好事" />
            )}
          </Card>
        );
      })()}

    </Space>
  );
}

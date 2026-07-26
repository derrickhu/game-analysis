import { Button, DatePicker, Layout, Select, Space, Tabs, Tag, Tooltip, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { ALL_GAMES, getGameDescriptor } from '../../shared/games';
import { PLATFORM_OPTIONS, type PlatformFilter } from '../../shared/platforms';
import { AnalyticsFilterProvider, useAnalyticsFilter } from '../context/AnalyticsFilterContext';
import {
  WINDOW_OPTIONS,
  isCustomRange,
  resolveWindow,
  type WindowValue,
} from '../timeWindow';
import { TopLevelTabs } from './TopLevelTabs';

const { RangePicker } = DatePicker;
const { Header, Content } = Layout;
const { Title, Text } = Typography;

/**
 * 业务分析子 Tab（大盘 / 玩法 / 玩家档案 / 原始事件）的导航。
 * 单独抽出来因为它需要在 location 变化时跟随高亮，且和 URL pathname 一一对应。
 *
 * 「玩家档案」与其它 tab 的差异：每日全量 DB 快照，不响应时间窗口；
 * 仍然共用业务 layout 的游戏选择器（用 gameKey 切换不同游戏的快照）。
 */
function BusinessSubTabs() {
  const navigate = useNavigate();
  const location = useLocation();
  const subKey = (() => {
    if (location.pathname.startsWith('/business/retention')) return 'retention';
    if (location.pathname.startsWith('/business/attribution')) return 'attribution';
    if (
      location.pathname.startsWith('/business/commercial') ||
      location.pathname.startsWith('/business/ltv') ||
      location.pathname.startsWith('/business/roi')
    ) return 'commercial';
    if (location.pathname.startsWith('/business/gameplay')) return 'gameplay';
    if (location.pathname.startsWith('/business/player-snapshot')) return 'player-snapshot';
    if (location.pathname.startsWith('/business/events')) return 'events';
    return 'dashboard';
  })();
  return (
    <Tabs
      activeKey={subKey}
      onChange={(key) => {
        // 切子 Tab 时保留 URL 上的 ?game=&platform=&window= 查询参数（由 Provider 主动写回的真值），
        // 避免"切到原始事件再切回大盘，时间窗口/游戏/平台被重置成默认值"
        navigate({ pathname: `/business/${key}`, search: location.search });
      }}
      items={[
        { key: 'dashboard', label: '大盘运营' },
        { key: 'retention', label: '留存分析' },
        { key: 'commercial', label: '商业化分析' },
        { key: 'attribution', label: '广告归因' },
        { key: 'gameplay', label: '玩法分析' },
        { key: 'player-snapshot', label: '玩家档案' },
        { key: 'events', label: '原始事件' },
      ]}
    />
  );
}

/**
 * 顶部 Header 上的业务过滤器（游戏选择器 / 时间窗口 / 刷新 / 立即拉取）。
 * 抽出来是因为它要消费 AnalyticsFilterContext，必须在 Provider 内部。
 */
function BusinessHeaderControls() {
  const location = useLocation();
  const {
    gameKey,
    setGameKey,
    platform,
    setPlatform,
    windowSel,
    setWindowSel,
    triggerRefresh,
    triggerIngestNow,
    loading,
    ingestingNow,
    lastRefreshedAt,
  } = useAnalyticsFilter();

  const gameDescriptor = getGameDescriptor(gameKey);
  const isIntegrated = gameDescriptor?.hasAnalyticsSdk === true;
  const resolved = resolveWindow(windowSel);
  const usesPageTimeWindow =
    location.pathname.startsWith('/business/commercial') ||
    location.pathname.startsWith('/business/ltv') ||
    location.pathname.startsWith('/business/roi') ||
    location.pathname.startsWith('/business/attribution');

  return (
    <Space wrap>
      <Select
        value={gameKey}
        onChange={(value) => setGameKey(value)}
        className="game-input"
        style={{ minWidth: 200 }}
        options={ALL_GAMES.map((item) => ({
          value: item.gameKey,
          label: (
            <Space>
              <span>{item.displayName}</span>
              {!item.hasAnalyticsSdk && (
                <Tag color="default" style={{ marginInlineEnd: 0 }}>
                  未接入
                </Tag>
              )}
            </Space>
          ),
        }))}
      />
      <Select
        value={platform}
        onChange={(value) => setPlatform(value as PlatformFilter)}
        style={{ minWidth: 120 }}
        options={PLATFORM_OPTIONS}
        disabled={!isIntegrated}
      />
      {usesPageTimeWindow ? (
        <Tag color="blue">本页使用页内时间窗口</Tag>
      ) : (
        <>
          {/*
            时间窗口快捷下拉：仅承载预设档位，自定义时间范围由右侧 RangePicker 接管。
            当前是自定义状态时，下拉清空显示，提示用户区间已由 RangePicker 决定。
          */}
          <Select
            value={isCustomRange(windowSel) ? undefined : windowSel}
            placeholder="自定义时间窗口"
            onChange={(v) => setWindowSel(v as WindowValue)}
            options={WINDOW_OPTIONS}
            style={{ width: 160 }}
            disabled={!isIntegrated}
            allowClear={false}
          />
          <RangePicker
            format="YYYY-MM-DD"
            allowClear={false}
            disabled={!isIntegrated}
            value={[dayjs(resolved.fromTs), dayjs(resolved.toTs)] as [Dayjs, Dayjs]}
            onChange={(range) => {
              if (!range || !range[0] || !range[1]) return;
              // 落地为 首日 00:00 ~ 末日 23:59:59.999；真正发 API 时再由 timeWindow 做 min(..., now)
              const fromTs = range[0].startOf('day').valueOf();
              const toTs = range[1].endOf('day').valueOf();
              if (toTs <= fromTs) {
                message.warning('结束时间必须晚于开始时间');
                return;
              }
              setWindowSel({ kind: 'range', fromTs, toTs });
            }}
            presets={[
              {
                label: '今天',
                value: [dayjs().startOf('day'), dayjs().endOf('day')] as [Dayjs, Dayjs],
              },
              {
                label: '昨天',
                value: [
                  dayjs().subtract(1, 'day').startOf('day'),
                  dayjs().subtract(1, 'day').endOf('day'),
                ] as [Dayjs, Dayjs],
              },
              {
                label: '近 7 天',
                value: [
                  dayjs().subtract(6, 'day').startOf('day'),
                  dayjs().endOf('day'),
                ] as [Dayjs, Dayjs],
              },
              {
                label: '近 30 天',
                value: [
                  dayjs().subtract(29, 'day').startOf('day'),
                  dayjs().endOf('day'),
                ] as [Dayjs, Dayjs],
              },
            ]}
          />
        </>
      )}
      <Button onClick={() => triggerRefresh()} loading={loading} disabled={!isIntegrated}>
        刷新
      </Button>
      <Tooltip title="手动从 CloudBase 增量拉取一次事件到本地（绕过 5 分钟 cron），完成后自动刷新所有面板">
        <Button
          type="primary"
          onClick={() => void triggerIngestNow()}
          loading={ingestingNow}
          disabled={!isIntegrated}
        >
          立即拉取并刷新
        </Button>
      </Tooltip>
      <Text type="secondary">
        自动 5 分钟 · {lastRefreshedAt ? new Date(lastRefreshedAt).toLocaleString('zh-CN') : '-'}
      </Text>
    </Space>
  );
}

/**
 * 业务分析 Layout。
 *
 * 结构：
 *   Header（Title + 业务过滤器）
 *   ├─ TopLevelTabs（业务/运维）
 *   ├─ BusinessSubTabs（大盘/玩法/原始事件）
 *   └─ Outlet（具体子 Page）
 *
 * AnalyticsFilterProvider 只在这里 mount，OpsLayout 完全不依赖此 Context，
 * 也避免 OpsLayout 被无关的 ?game=&window= 查询参数污染 URL。
 */
export function BusinessLayout() {
  return (
    <AnalyticsFilterProvider>
      <Layout className="app-shell">
        <Header className="app-header">
          <div>
            <Title level={3} className="app-title">
              游戏经营分析
            </Title>
            <Text type="secondary">
              已接入 @gp/analytics-sdk 的游戏从打点流水拉数据，未接入的请先按指引接入
            </Text>
          </div>
          <BusinessHeaderControls />
        </Header>

        <Content className="app-content">
          <TopLevelTabs />
          <BusinessSubTabs />
          <Outlet />
        </Content>
      </Layout>
    </AnalyticsFilterProvider>
  );
}

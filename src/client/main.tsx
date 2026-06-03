import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'antd/dist/reset.css';
import { Navigate, RouterProvider, createBrowserRouter } from 'react-router-dom';

import { BusinessLayout } from './layouts/BusinessLayout';
import { OpsLayout } from './layouts/OpsLayout';
import { AttributionPage } from './pages/AttributionPage';
import { CommercialPage } from './pages/CommercialPage';
import { DashboardPage } from './pages/DashboardPage';
import { EventsPage } from './pages/EventsPage';
import { GameplayPage } from './pages/GameplayPage';
import { OpsPage } from './pages/OpsPage';
import { PlayerSnapshotPage } from './pages/PlayerSnapshotPage';
import { RetentionPage } from './pages/RetentionPage';
import './styles.css';

/**
 * 路由结构（v7 createBrowserRouter）：
 *   /                          → 重定向 /business/dashboard
 *   /business                  → 重定向 /business/dashboard
 *   /business/dashboard?game=&window=         大盘运营（通用：KPI + 活跃趋势 + 广告 + 分享）
 *   /business/retention?game=                 留存分析（cohort D0-D30 + 设备拆分）
 *   /business/commercial?game=&window=        商业化分析（ROI 决策 + LTV 回收 + 真实录入）
 *   /business/attribution?game=                 广告归因（Campaign 质量 + 回传 dry-run）
 *   /business/gameplay?game=&window=          玩法分析（按 gameKey 渲染各自漏斗 panel）
 *   /business/player-snapshot?game=           玩家档案（每日全量 DB 快照，不响应时间窗口）
 *   /business/events?game=&window=            原始事件（EventsExplorer）
 *   /ops                                      系统运维（不依赖游戏 / 时间窗口，URL 永远干净）
 *
 * URL 上的 ?game= / ?window= 由 BusinessLayout 内 mount 的 AnalyticsFilterProvider 读写，
 * /ops 不 mount Provider，所以系统运维页面 URL 不会被业务过滤参数污染。
 *
 * Tab 切换通过 location.pathname 推断 activeKey，浏览器后退/前进或粘贴 URL 都能正确反映视图。
 */
const router = createBrowserRouter([
  {
    path: '/',
    element: <Navigate to="/business/dashboard" replace />,
  },
  {
    path: '/business',
    element: <BusinessLayout />,
    children: [
      { index: true, element: <Navigate to="/business/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'retention', element: <RetentionPage /> },
      { path: 'commercial', element: <CommercialPage /> },
      { path: 'attribution', element: <AttributionPage /> },
      { path: 'ltv', element: <Navigate to="/business/commercial" replace /> },
      { path: 'roi', element: <Navigate to="/business/commercial" replace /> },
      { path: 'gameplay', element: <GameplayPage /> },
      { path: 'player-snapshot', element: <PlayerSnapshotPage /> },
      { path: 'events', element: <EventsPage /> },
    ],
  },
  {
    path: '/ops',
    element: <OpsLayout />,
    children: [{ index: true, element: <OpsPage /> }],
  },
  // 兜底：未知路径回首页（避免因 typo 进入空白页）
  { path: '*', element: <Navigate to="/business/dashboard" replace /> },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN}>
      <RouterProvider router={router} />
    </ConfigProvider>
  </React.StrictMode>,
);

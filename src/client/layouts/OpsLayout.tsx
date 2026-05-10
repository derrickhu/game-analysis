import { Layout, Typography } from 'antd';
import { Outlet } from 'react-router-dom';

import { TopLevelTabs } from './TopLevelTabs';

const { Header, Content } = Layout;
const { Title, Text } = Typography;

/**
 * 系统运维 Layout。
 *
 * 与 BusinessLayout 的关键差异：
 *   - 无业务过滤器（gameKey/时间窗口/刷新/立即拉取按钮全部不展示）
 *   - 不 mount AnalyticsFilterProvider，避免运维页污染 URL
 *
 * 系统运维聚合显示所有已接入游戏的运行状态（清理 cron、上报健康度、容量监控等），
 * 切游戏不影响这一页内容；时间窗口由各运维卡片自管。
 */
export function OpsLayout() {
  return (
    <Layout className="app-shell">
      <Header className="app-header">
        <div>
          <Title level={3} className="app-title">
            游戏经营分析
          </Title>
          <Text type="secondary">
            系统运维：与具体游戏无关的全局功能（事件清理、上报健康度等），后续会接入容量监控与配置管理
          </Text>
        </div>
      </Header>
      <Content className="app-content">
        <TopLevelTabs />
        <Outlet />
      </Content>
    </Layout>
  );
}

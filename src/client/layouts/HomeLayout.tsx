import { Layout, Typography } from 'antd';
import { Link, Outlet } from 'react-router-dom';

import { TopLevelTabs } from './TopLevelTabs';

const { Header, Content } = Layout;
const { Title } = Typography;

/**
 * 经分总览主页 Layout：轻量顶栏 + 顶级导航，无游戏/平台/时间过滤器。
 */
export function HomeLayout() {
  return (
    <Layout className="app-shell app-shell-home">
      <Header className="app-header">
        <Link to="/" className="app-brand app-brand-link">
          <span className="app-brand-mark" aria-hidden>
            GP
          </span>
          <Title level={3} className="app-title">
            游戏经营分析
          </Title>
        </Link>
      </Header>
      <Content className="app-content app-content-home">
        <TopLevelTabs />
        <Outlet />
      </Content>
    </Layout>
  );
}

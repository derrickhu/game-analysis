import { Layout, Typography } from 'antd';
import { Link, Outlet } from 'react-router-dom';

import { TopLevelTabs } from './TopLevelTabs';

const { Header, Content } = Layout;
const { Title } = Typography;

/**
 * 经分总览主页 Layout：一体式深墨曜石指挥顶栏（品牌 + 顶级导航同行排布），释放首屏纵向高度。
 */
export function HomeLayout() {
  return (
    <Layout className="app-shell app-shell-home">
      <Header className="app-header app-header-home">
        <div className="app-header-home-left">
          <Link to="/" className="app-brand app-brand-link">
            <span className="app-brand-mark app-brand-mark-home" aria-hidden>
              GP
            </span>
            <Title level={3} className="app-title app-title-home">
              游戏经营分析
            </Title>
          </Link>
          <span className="app-header-home-divider" aria-hidden />
          <TopLevelTabs />
        </div>
        <div className="app-header-home-right">
          <span className="app-header-home-badge">DAILY COMMAND DECK</span>
        </div>
      </Header>
      <Content className="app-content app-content-home">
        <Outlet />
      </Content>
    </Layout>
  );
}

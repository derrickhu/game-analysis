import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * 顶级导航：总览 / 业务分析 / 系统运维
 *
 * activeKey 由 pathname 推断；切业务时进入大盘（保留现有看板入口）。
 */
export function TopLevelTabs() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeKey = location.pathname.startsWith('/ops')
    ? 'ops'
    : location.pathname.startsWith('/business')
      ? 'business'
      : 'home';

  return (
    <Tabs
      type="card"
      className="app-nav-primary"
      activeKey={activeKey}
      onChange={(key) => {
        if (key === 'home') navigate('/');
        else if (key === 'business') navigate('/business/dashboard');
        else navigate('/ops');
      }}
      items={[
        { key: 'home', label: '总览' },
        { key: 'business', label: '业务分析' },
        { key: 'ops', label: '系统运维' },
      ]}
      style={{ marginBottom: 0 }}
    />
  );
}

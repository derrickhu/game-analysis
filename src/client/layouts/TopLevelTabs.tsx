import { Tabs } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * 顶级导航：业务分析 / 系统运维
 *
 * 切到业务时进入 /business/dashboard（业务首页）；切到运维时进入 /ops。
 * activeKey 由当前 pathname 推断，浏览器后退/前进或粘贴 URL 都会自然反映。
 */
export function TopLevelTabs() {
  const navigate = useNavigate();
  const location = useLocation();
  const activeKey = location.pathname.startsWith('/ops') ? 'ops' : 'business';

  return (
    <Tabs
      type="card"
      className="app-nav-primary"
      activeKey={activeKey}
      onChange={(key) => {
        if (key === 'business') navigate('/business/dashboard');
        else navigate('/ops');
      }}
      items={[
        { key: 'business', label: '业务分析' },
        { key: 'ops', label: '系统运维' },
      ]}
      style={{ marginBottom: 0 }}
    />
  );
}

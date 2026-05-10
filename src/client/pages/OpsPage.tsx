import { SystemOpsPanel } from '../SystemOpsPanel';

/**
 * 系统运维页面：完全薄壳，SystemOpsPanel 自管刷新与全局视角，不依赖 AnalyticsFilterContext。
 */
export function OpsPage() {
  return <SystemOpsPanel />;
}

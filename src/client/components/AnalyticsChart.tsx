import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import type { EChartsReactProps } from 'echarts-for-react';

import { ECHARTS_THEME_NAME, polishChartOption } from '../theme/echartsTheme';

export type AnalyticsChartProps = Omit<EChartsReactProps, 'option' | 'theme'> & {
  option: EChartsOption | Record<string, unknown>;
  /** 默认 320，与旧面板高度对齐 */
  height?: number | string;
  /** 外层是否包一层图表容器（圆角浅底） */
  framed?: boolean;
};

/**
 * 统一图表壳：注册主题 + 专业默认样式（渐变柱 / 平滑曲线 / 暗色 tooltip）。
 */
export function AnalyticsChart({
  option,
  height = 320,
  style,
  opts,
  notMerge = true,
  lazyUpdate = true,
  framed = true,
  className,
  ...rest
}: AnalyticsChartProps) {
  const polished = useMemo(() => {
    try {
      return polishChartOption(option);
    } catch (error) {
      console.error('[AnalyticsChart] polishChartOption failed, fallback to raw option', error);
      return option as EChartsOption;
    }
  }, [option]);

  const chart = (
    <ReactECharts
      theme={ECHARTS_THEME_NAME}
      option={polished}
      notMerge={notMerge}
      lazyUpdate={lazyUpdate}
      opts={{ renderer: 'canvas', ...opts }}
      style={{ width: '100%', height, ...style }}
      className={className}
      {...rest}
    />
  );

  if (!framed) return chart;

  return <div className="ga-chart-frame">{chart}</div>;
}

/** 兼容旧 `import ReactECharts from 'echarts-for-react'` 的默认导出替换 */
export default AnalyticsChart;

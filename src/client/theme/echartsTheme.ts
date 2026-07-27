import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';

import {
  CHART_SERIES_PALETTE,
  areaGradient,
  barGradient,
  chartColors,
  hexToRgba,
  remapLegacyColor,
} from './chartPalette';
import { tokens } from './tokens';

export const ECHARTS_THEME_NAME = 'gp-analytics';

const axisCommon = {
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: {
    color: tokens.color.textMuted,
    fontSize: 11,
    fontFamily: tokens.font.sans,
    margin: 10,
  },
  splitLine: {
    show: true,
    lineStyle: {
      color: '#e8f1f8',
      type: 'dashed' as const,
      width: 1,
    },
  },
  splitArea: { show: false },
};

/** 注册全局 ECharts 主题（只调用一次） */
export function registerAnalyticsChartTheme(): void {
  echarts.registerTheme(ECHARTS_THEME_NAME, {
    color: [...CHART_SERIES_PALETTE],
    backgroundColor: 'transparent',
    textStyle: {
      color: tokens.color.textSecondary,
      fontFamily: tokens.font.sans,
      fontSize: 12,
    },
    title: {
      textStyle: {
        color: tokens.color.text,
        fontWeight: 650,
        fontSize: 14,
        fontFamily: tokens.font.sans,
      },
      subtextStyle: { color: tokens.color.textMuted, fontSize: 12 },
    },
    legend: {
      textStyle: {
        color: tokens.color.textSecondary,
        fontSize: 12,
        fontFamily: tokens.font.sans,
      },
      pageTextStyle: { color: tokens.color.textMuted },
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 8,
      itemGap: 16,
    },
    tooltip: {
      backgroundColor: 'rgba(255, 255, 255, 0.97)',
      borderColor: '#c9d6e8',
      borderWidth: 1,
      padding: [12, 16],
      textStyle: {
        color: tokens.color.text,
        fontSize: 12,
        fontFamily: tokens.font.sans,
      },
      extraCssText: `border-radius:12px;box-shadow:0 12px 32px rgba(29,78,216,0.14);backdrop-filter:blur(10px);`,
    },
    categoryAxis: axisCommon,
    valueAxis: {
      ...axisCommon,
      axisLine: { show: false },
    },
    logAxis: axisCommon,
    timeAxis: axisCommon,
    line: {
      itemStyle: { borderWidth: 2 },
      lineStyle: { width: 2.75 },
      symbolSize: 7,
      symbol: 'circle',
      smooth: 0.35,
    },
    bar: {
      itemStyle: { borderRadius: [6, 6, 2, 2] },
      barMaxWidth: 40,
      barGap: '28%',
    },
    pie: {
      itemStyle: {
        borderColor: tokens.color.bgElevated,
        borderWidth: 3,
      },
    },
    funnel: {
      itemStyle: {
        borderColor: tokens.color.bgElevated,
        borderWidth: 2,
      },
    },
    dataZoom: {
      dataBackground: {
        lineStyle: { color: chartColors.primary, opacity: 0.35 },
        areaStyle: { color: tokens.color.accentSoft },
      },
      selectedDataBackground: {
        lineStyle: { color: chartColors.primary },
        areaStyle: { color: tokens.color.accentSoft },
      },
      fillerColor: 'rgba(37, 99, 235, 0.14)',
      borderColor: tokens.color.border,
      handleStyle: { color: chartColors.primary },
      textStyle: { color: tokens.color.textMuted },
    },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMerge(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function extractSolidColor(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.startsWith('#')) {
    return String(remapLegacyColor(value));
  }
  if (typeof value === 'string' && value.startsWith('rgb')) {
    return value;
  }
  return fallback;
}

function polishSeriesItem(
  item: Record<string, unknown>,
  index: number,
  ctx: { lineCount: number; barCount: number },
): Record<string, unknown> {
  const type = item.type as string | undefined;
  const paletteColor = CHART_SERIES_PALETTE[index % CHART_SERIES_PALETTE.length];
  const next: Record<string, unknown> = { ...item };

  // 递归 remap data 内 itemStyle.color（漏斗/饼图常见）
  if (Array.isArray(next.data)) {
    next.data = next.data.map((d) => {
      if (!isPlainObject(d)) return d;
      const row = { ...d };
      if (isPlainObject(row.itemStyle) && typeof row.itemStyle.color === 'string') {
        row.itemStyle = {
          ...row.itemStyle,
          color: remapLegacyColor(row.itemStyle.color),
        };
      }
      return row;
    });
  }

  const itemStyle = isPlainObject(next.itemStyle) ? { ...next.itemStyle } : {};
  const lineStyle = isPlainObject(next.lineStyle) ? { ...next.lineStyle } : {};
  const areaStyle = isPlainObject(next.areaStyle) ? { ...next.areaStyle } : null;

  if (typeof itemStyle.color === 'string') {
    itemStyle.color = remapLegacyColor(itemStyle.color);
  }
  if (typeof lineStyle.color === 'string') {
    lineStyle.color = remapLegacyColor(lineStyle.color);
  }

  if (type === 'bar') {
    const base =
      typeof itemStyle.color === 'string'
        ? extractSolidColor(itemStyle.color, paletteColor)
        : paletteColor;
    const isHorizontal = next.xAxisIndex === undefined && false; // 默认竖柱
    // 仅当颜色是纯色字符串时升为渐变；已是 gradient 对象则保留
    if (typeof itemStyle.color === 'string' || itemStyle.color === undefined) {
      itemStyle.color = barGradient(base, Boolean(isHorizontal));
    }
    if (!itemStyle.borderRadius) {
      itemStyle.borderRadius = [6, 6, 2, 2];
    }
    next.itemStyle = itemStyle;
    if (next.barMaxWidth === undefined) next.barMaxWidth = 40;
    if (next.emphasis === undefined) {
      next.emphasis = {
        focus: 'series',
        itemStyle: { shadowBlur: 10, shadowColor: hexToRgba(base, 0.35) },
      };
    }
  }

  if (type === 'line') {
    const base =
      typeof lineStyle.color === 'string'
        ? extractSolidColor(lineStyle.color, paletteColor)
        : typeof itemStyle.color === 'string'
          ? extractSolidColor(itemStyle.color, paletteColor)
          : paletteColor;

    if (!lineStyle.color) lineStyle.color = base;
    if (lineStyle.width === undefined || (typeof lineStyle.width === 'number' && lineStyle.width < 2)) {
      lineStyle.width = 2.75;
    }
    lineStyle.cap = 'round';
    lineStyle.join = 'round';

    if (itemStyle.color === undefined || typeof itemStyle.color === 'string') {
      itemStyle.color = base;
    }
    itemStyle.borderColor = '#fff';
    itemStyle.borderWidth = 2;

    if (next.smooth === undefined) next.smooth = 0.35;
    if (next.showSymbol === undefined) next.showSymbol = ctx.lineCount <= 2;
    if (next.symbol === undefined) next.symbol = 'circle';
    if (next.symbolSize === undefined) next.symbolSize = 7;

    // 面积：已有 areaStyle 升级为渐变；单/双线自动补淡面积
    if (areaStyle || ctx.lineCount <= 2) {
      const topOp = areaStyle && typeof (areaStyle as { opacity?: number }).opacity === 'number'
        ? Math.max(0.12, Number((areaStyle as { opacity?: number }).opacity) + 0.1)
        : ctx.lineCount === 1
          ? 0.32
          : 0.18;
      next.areaStyle = {
        ...(areaStyle || {}),
        color: areaGradient(base, topOp, 0.02),
        opacity: 1,
      };
    }

    next.lineStyle = lineStyle;
    next.itemStyle = itemStyle;
    if (next.emphasis === undefined) {
      next.emphasis = {
        focus: 'series',
        scale: true,
        lineStyle: { width: 3.25 },
      };
    }
  }

  if (type === 'pie' || type === 'funnel') {
    if (!itemStyle.borderColor) itemStyle.borderColor = '#fff';
    if (!itemStyle.borderWidth) itemStyle.borderWidth = type === 'pie' ? 3 : 2;
    next.itemStyle = itemStyle;
  }

  if (isPlainObject(next.emphasis)) {
    const emphasis = { ...next.emphasis };
    if (isPlainObject(emphasis.itemStyle) && typeof emphasis.itemStyle.color === 'string') {
      emphasis.itemStyle = {
        ...emphasis.itemStyle,
        color: remapLegacyColor(emphasis.itemStyle.color),
      };
    }
    next.emphasis = emphasis;
  }

  return next;
}

function countSeriesTypes(series: unknown[]): { lineCount: number; barCount: number } {
  let lineCount = 0;
  let barCount = 0;
  for (const s of series) {
    if (!isPlainObject(s)) continue;
    if (s.type === 'line') lineCount += 1;
    if (s.type === 'bar') barCount += 1;
  }
  return { lineCount, barCount };
}

function polishAxes(option: Record<string, unknown>): void {
  const polishAxis = (axis: unknown): unknown => {
    if (Array.isArray(axis)) return axis.map((a) => polishAxis(a));
    if (!isPlainObject(axis)) return axis;
    const next = { ...axis };
    const axisLabel = isPlainObject(next.axisLabel) ? { ...next.axisLabel } : {};
    if (typeof axisLabel.color === 'string') {
      axisLabel.color = remapLegacyColor(axisLabel.color);
    } else if (axisLabel.color === undefined) {
      axisLabel.color = tokens.color.textMuted;
    }
    next.axisLabel = axisLabel;

    const nameTextStyle = isPlainObject(next.nameTextStyle) ? { ...next.nameTextStyle } : {};
    if (typeof nameTextStyle.color === 'string') {
      nameTextStyle.color = remapLegacyColor(nameTextStyle.color);
    }
    if (Object.keys(nameTextStyle).length) next.nameTextStyle = nameTextStyle;

    if (next.splitLine === undefined && next.type !== 'category') {
      next.splitLine = {
        show: true,
        lineStyle: { color: '#e8f1f8', type: 'dashed' },
      };
    }
    if (next.axisTick === undefined) next.axisTick = { show: false };
    return next;
  };

  if (option.xAxis !== undefined) option.xAxis = polishAxis(option.xAxis);
  if (option.yAxis !== undefined) option.yAxis = polishAxis(option.yAxis);
}

/**
 * 深度抛光：补齐 grid/tooltip，并把 series 升级为渐变柱 / 平滑曲线 / 淡面积。
 */
export function polishChartOption(option: EChartsOption | Record<string, unknown>): EChartsOption {
  const defaults: EChartsOption = {
    color: [...CHART_SERIES_PALETTE],
    animationDuration: 560,
    animationEasing: 'cubicOut',
    grid: {
      left: 16,
      right: 20,
      top: 52,
      bottom: 28,
      containLabel: true,
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        crossStyle: { color: tokens.color.borderStrong },
        lineStyle: { color: tokens.color.borderStrong, width: 1, type: 'dashed' },
        shadowStyle: { color: 'rgba(37, 99, 235, 0.06)' },
      },
    },
  };

  const merged = deepMerge(
    defaults as Record<string, unknown>,
    (option || {}) as Record<string, unknown>,
  );

  // title 文字色 remap
  if (isPlainObject(merged.title)) {
    const title = { ...merged.title };
    const textStyle = isPlainObject(title.textStyle) ? { ...title.textStyle } : {};
    if (typeof textStyle.color === 'string') {
      textStyle.color = String(remapLegacyColor(textStyle.color));
    }
    title.textStyle = textStyle;
    merged.title = title;
  }
  if (isPlainObject(merged.legend)) {
    const legend = { ...merged.legend };
    const textStyle: Record<string, unknown> = isPlainObject(legend.textStyle)
      ? { color: tokens.color.textSecondary, fontSize: 12, ...legend.textStyle }
      : { color: tokens.color.textSecondary, fontSize: 12 };
    if (typeof textStyle.color === 'string') {
      textStyle.color = String(remapLegacyColor(textStyle.color));
    }
    legend.textStyle = textStyle;
    if (legend.icon === undefined) legend.icon = 'roundRect';
    if (legend.itemGap === undefined) legend.itemGap = 16;
    if (legend.top === undefined && legend.bottom === undefined) legend.top = 4;
    merged.legend = legend;
  }

  polishAxes(merged);

  const series = merged.series;
  if (Array.isArray(series)) {
    const ctx = countSeriesTypes(series);
    merged.series = series.map((item, index) => {
      if (!isPlainObject(item)) return item;
      return polishSeriesItem(item, index, ctx);
    });
  } else if (isPlainObject(series)) {
    merged.series = polishSeriesItem(series, 0, countSeriesTypes([series]));
  }

  // pie / funnel 用 item tooltip
  if (Array.isArray(merged.series)) {
    const first = merged.series[0];
    if (isPlainObject(first) && (first.type === 'pie' || first.type === 'funnel')) {
      const tip = isPlainObject(merged.tooltip) ? { ...merged.tooltip } : {};
      if (tip.trigger === 'axis' || tip.trigger === undefined) tip.trigger = 'item';
      merged.tooltip = tip;
    }
  }

  return merged as EChartsOption;
}

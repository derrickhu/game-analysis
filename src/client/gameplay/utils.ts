/**
 * 玩法面板共享工具：日期格式化、百分比展示、桶 X 轴标签等。
 * 4 个 huahua-* 面板复用一份，避免每个 panel 内联同样的 helper。
 */

/**
 * 5 分钟桶字符串 → 紧凑 X 轴标签（MM-DD HH:mm，本地时区）。
 * 与 LevelProgressPanel 中的 bucketShort 完全一致，行为对齐避免不同 panel X 轴显示差异。
 */
export function bucketShort(bucket: string): string {
  if (!bucket) return '';
  const utcDate = new Date(`${bucket}:00.000Z`);
  if (isNaN(utcDate.getTime())) return bucket;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(utcDate.getMonth() + 1)}-${pad(utcDate.getDate())} ${pad(utcDate.getHours())}:${pad(utcDate.getMinutes())}`;
}

/** 比例（0~1）→ 百分比展示，null/undefined 显示 '-' */
export function formatPercent(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '-';
  return `${(rate * 100).toFixed(digits)}%`;
}

/** 整数千分位逗号分隔 */
export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('zh-CN');
}

/**
 * 趋势图默认 dataZoom 起点：始终展示当前查询窗口全量
 *（顶部选「今天」= 自然日 00:00 ~ now）。需要局部放大时拖 slider。
 */
export function defaultZoomStart(_seriesLength: number, _visibleCount = 60): number {
  return 0;
}

// ─── ECharts 通用布局常量 ─────────────────────────────────────
//
// 历史问题：很多图表 grid.bottom=60 + dataZoom.slider {bottom:10, height:18}，
// xAxis 标签紧贴 grid 底（≈30px），dataZoom 顶部到 bottom=28，留给 xAxis 的
// (60-28)=32px 经常不够，导致 “第1关 第2关...” 这种类目标签和缩略图重叠。
//
// 统一改成 grid.bottom=80 + slider {bottom:14, height:18}（顶部到容器底 32px），
// 给 xAxis tick+label 留 (80-32)=48px 富裕空间，所有带 dataZoom 的图都套这套。
//
// 不带 dataZoom 的图可以继续用 grid.bottom: 40~50，不需要这么多余白。

/** 带 dataZoom slider 的图表统一 grid 余白，确保 xAxis label 不会压在缩略图上 */
export const CHART_GRID_WITH_ZOOM = { left: 50, right: 30, top: 56, bottom: 80 } as const;

/** 不带 dataZoom slider、且没有顶部 legend 的紧凑图表 */
export const CHART_GRID_COMPACT = { left: 50, right: 30, top: 40, bottom: 48 } as const;

/** 顶部 legend 通用样式：放在 chart 顶部 12px，给 grid.top: 56 让出空间 */
export const CHART_LEGEND_TOP = {
  top: 12,
  textStyle: { color: '#374151', fontSize: 13, fontWeight: 500 },
} as const;

/**
 * dataZoom slider 通用样式：bottom:14 + height:18 → 占容器底 [14, 32]，
 * 与 grid.bottom=80 留出的 xAxis 区 [32, 80] 不重叠。
 */
export function makeDataZoom(zoomStart = 0, zoomEnd = 100) {
  return [
    { type: 'inside' as const, start: zoomStart, end: zoomEnd },
    {
      type: 'slider' as const,
      height: 18,
      bottom: 14,
      start: zoomStart,
      end: zoomEnd,
    },
  ];
}

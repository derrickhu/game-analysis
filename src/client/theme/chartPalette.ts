import * as echarts from 'echarts';

import { tokens } from './tokens';

const { graphic } = echarts;

/** 中饱和多色系列（12 色，偏实色不发灰） */
export const chartColors = {
  primary: '#2563eb',
  secondary: '#0891b2',
  tertiary: '#7c3aed',
  quaternary: '#d97706',
  success: '#059669',
  danger: '#e11d48',
  warning: '#ea580c',
  muted: '#64748b',
  purple: '#4f46e5',
  pink: '#db2777',
  cyan: '#0d9488',
  lime: '#16a34a',
  orange: '#f59e0b',
  sky: '#0284c7',
  slate: '#475569',
} as const;

export const CHART_SERIES_PALETTE = [
  chartColors.primary,
  chartColors.success,
  chartColors.quaternary,
  chartColors.tertiary,
  chartColors.pink,
  chartColors.cyan,
  chartColors.secondary,
  chartColors.warning,
  chartColors.lime,
  chartColors.purple,
  chartColors.sky,
  chartColors.danger,
] as const;

/** 旧硬编码 / 上一版浅色 → 中深实色 */
export const LEGACY_COLOR_MAP: Record<string, string> = {
  '#0f766e': chartColors.cyan,
  '#0d9488': chartColors.cyan,
  '#0ea5e9': chartColors.sky,
  '#38bdf8': chartColors.primary,
  '#60a5fa': chartColors.primary,
  '#34d399': chartColors.success,
  '#fbbf24': chartColors.quaternary,
  '#a78bfa': chartColors.tertiary,
  '#fb7185': chartColors.danger,
  '#2dd4bf': chartColors.cyan,
  '#f472b6': chartColors.pink,
  '#4ade80': chartColors.lime,
  '#818cf8': chartColors.purple,
  '#22d3ee': chartColors.secondary,
  '#7dd3fc': chartColors.sky,
  '#0284c7': chartColors.sky,
  '#0369a1': chartColors.sky,
  '#059669': chartColors.success,
  '#047857': chartColors.success,
  '#d97706': chartColors.quaternary,
  '#b45309': chartColors.warning,
  '#e11d48': chartColors.danger,
  '#be123c': chartColors.danger,
  '#7c3aed': chartColors.tertiary,
  '#6366f1': chartColors.purple,
  '#0891b2': chartColors.secondary,
  '#3b82f6': chartColors.primary,
  '#3B82F6': chartColors.primary,
  '#5B8FF9': chartColors.primary,
  '#3D7BFA': chartColors.primary,
  '#1677ff': chartColors.primary,
  '#1677FF': chartColors.primary,
  '#2563eb': chartColors.primary,
  '#2563EB': chartColors.primary,
  '#1d4ed8': chartColors.primary,
  '#f59e0b': chartColors.orange,
  '#F59E0B': chartColors.orange,
  '#FF8A3D': chartColors.warning,
  '#f97316': chartColors.warning,
  '#F97316': chartColors.warning,
  '#10b981': chartColors.success,
  '#10B981': chartColors.success,
  '#22c55e': chartColors.lime,
  '#52C41A': chartColors.success,
  '#ef4444': chartColors.danger,
  '#EF4444': chartColors.danger,
  '#a855f7': chartColors.tertiary,
  '#A855F7': chartColors.tertiary,
  '#8b5cf6': chartColors.purple,
  '#8B5CF6': chartColors.purple,
  '#722ED1': chartColors.tertiary,
  '#13C2C2': chartColors.secondary,
  '#94a3b8': chartColors.muted,
  '#94A3B8': chartColors.muted,
  '#cbd5e1': '#cbd5e1',
  '#374151': tokens.color.textSecondary,
  '#475569': tokens.color.textSecondary,
  '#262626': tokens.color.text,
  '#0f172a': tokens.color.text,
  '#595959': tokens.color.textMuted,
  '#64748b': tokens.color.textMuted,
};

export function hexToRgba(hex: string, alpha: number): string {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (full.length !== 6) return `rgba(37, 99, 235, ${alpha})`;
  const n = Number.parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function remapLegacyColor(color: unknown): unknown {
  if (typeof color !== 'string') return color;
  const trimmed = color.trim();
  if (LEGACY_COLOR_MAP[trimmed]) return LEGACY_COLOR_MAP[trimmed];
  const lower = trimmed.toLowerCase();
  for (const [from, to] of Object.entries(LEGACY_COLOR_MAP)) {
    if (from.toLowerCase() === lower) return to;
  }
  return color;
}

export function barGradient(color: string, horizontal = false) {
  const c = String(remapLegacyColor(color));
  if (horizontal) {
    return new graphic.LinearGradient(0, 0, 1, 0, [
      { offset: 0, color: hexToRgba(c, 0.78) },
      { offset: 1, color: c },
    ]);
  }
  return new graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: c },
    { offset: 1, color: hexToRgba(c, 0.78) },
  ]);
}

export function areaGradient(color: string, topOpacity = 0.26, bottomOpacity = 0.03) {
  const c = String(remapLegacyColor(color));
  return new graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: hexToRgba(c, topOpacity) },
    { offset: 1, color: hexToRgba(c, bottomOpacity) },
  ]);
}

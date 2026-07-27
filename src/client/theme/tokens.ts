/**
 * GP Analytics 设计 token — 中深色对比 + 多色图表
 * 底色略沉、强调色更实，避免发灰发白的「洗白」感。
 */

export const tokens = {
  color: {
    bg: '#e8eef6',
    bgElevated: '#ffffff',
    bgMuted: '#d9e3f0',
    bgSubtle: '#f3f6fb',
    border: '#c9d6e8',
    borderStrong: '#a8bcd4',
    text: '#0f172a',
    textSecondary: '#334155',
    textMuted: '#64748b',
    textInverse: '#ffffff',
    accent: '#1d4ed8',
    accentSoft: '#dbeafe',
    accentHover: '#2563eb',
    accentContrast: '#ffffff',
    info: '#0284c7',
    infoSoft: '#e0f2fe',
    success: '#047857',
    successSoft: '#d1fae5',
    warning: '#b45309',
    warningSoft: '#fef3c7',
    danger: '#be123c',
    dangerSoft: '#ffe4e6',
    chart: [
      '#2563eb',
      '#059669',
      '#d97706',
      '#7c3aed',
      '#db2777',
      '#0891b2',
      '#ea580c',
      '#4f46e5',
      '#16a34a',
      '#e11d48',
      '#0d9488',
      '#ca8a04',
    ],
  },
  radius: {
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
  },
  shadow: {
    sm: '0 1px 3px rgba(15, 23, 42, 0.06)',
    md: '0 8px 24px rgba(29, 78, 216, 0.1)',
    lg: '0 16px 40px rgba(15, 23, 42, 0.12)',
  },
  font: {
    sans: '"DM Sans", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Segoe UI", sans-serif',
    mono: '"IBM Plex Mono", "SF Mono", Menlo, Consolas, monospace',
  },
} as const;

export type DesignTokens = typeof tokens;

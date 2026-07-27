import type { ThemeConfig } from 'antd';

import { tokens } from './tokens';

/** Ant Design 6 主题：与 token 对齐，统一卡片/表格/页签观感 */
export const antdTheme: ThemeConfig = {
  cssVar: { prefix: 'ga' },
  hashed: false,
  token: {
    colorPrimary: tokens.color.accent,
    colorInfo: tokens.color.info,
    colorSuccess: tokens.color.success,
    colorWarning: tokens.color.warning,
    colorError: tokens.color.danger,
    colorText: tokens.color.text,
    colorTextSecondary: tokens.color.textSecondary,
    colorTextTertiary: tokens.color.textMuted,
    colorBorder: tokens.color.border,
    colorBorderSecondary: tokens.color.border,
    colorBgLayout: tokens.color.bg,
    colorBgContainer: tokens.color.bgElevated,
    colorBgElevated: tokens.color.bgElevated,
    colorFillAlter: tokens.color.bgSubtle,
    borderRadius: tokens.radius.md,
    borderRadiusLG: tokens.radius.lg,
    borderRadiusSM: tokens.radius.sm,
    fontFamily: tokens.font.sans,
    fontSize: 14,
    controlHeight: 36,
    wireframe: false,
    boxShadow: tokens.shadow.sm,
    boxShadowSecondary: tokens.shadow.md,
  },
  components: {
    Layout: {
      headerBg: tokens.color.bgElevated,
      headerPadding: '0 28px',
      headerHeight: 'auto',
      bodyBg: tokens.color.bg,
    },
    Card: {
      borderRadiusLG: tokens.radius.lg,
      paddingLG: 20,
      headerFontSize: 15,
      headerFontSizeSM: 14,
      colorBorderSecondary: tokens.color.border,
    },
    Tabs: {
      itemColor: tokens.color.textSecondary,
      itemSelectedColor: tokens.color.accent,
      itemHoverColor: tokens.color.accentHover,
      inkBarColor: tokens.color.accent,
      titleFontSize: 14,
      horizontalItemPadding: '10px 16px',
      cardBg: tokens.color.bgSubtle,
    },
    Table: {
      headerBg: tokens.color.bgSubtle,
      headerColor: tokens.color.textSecondary,
      rowHoverBg: tokens.color.accentSoft,
      borderColor: tokens.color.border,
      cellPaddingBlock: 12,
      cellPaddingInline: 14,
    },
    Statistic: {
      titleFontSize: 12,
      contentFontSize: 28,
    },
    Button: {
      primaryShadow: '0 2px 10px rgba(29, 78, 216, 0.28)',
      borderRadius: tokens.radius.sm,
      fontWeight: 560,
    },
    Select: {
      borderRadius: tokens.radius.sm,
    },
    Tag: {
      borderRadiusSM: 6,
    },
    Alert: {
      borderRadiusLG: tokens.radius.md,
    },
  },
};

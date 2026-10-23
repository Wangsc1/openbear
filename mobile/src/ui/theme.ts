/**
 * App 设计令牌：取自 web/src/theme-tokens.css（:root / html.dark）与 web/THEME.md 的颜色角色。
 * 值直接抄录，不另建色板；Web 色板变化时同步这里（P4 抽到 packages/core 后由同一来源生成）。
 * 界面方向见 workspace/artifacts/openbear-mobile/design/ui-direction-source.html。
 */
import { Platform, useColorScheme } from 'react-native';

export type Theme = {
  dark: boolean;
  /** 页面画布 --ob-bg */
  bg: string;
  /** 平板侧栏 --ob-sidebar */
  sidebar: string;
  /** 卡片、输入框、Sheet --ob-surface */
  panel: string;
  /** 浮层 --ob-surface-raised */
  raised: string;
  /** 内嵌底色、代码块、分段控件底 --ob-surface-soft */
  surfaceSoft: string;
  codeBg: string;
  /** 用户消息气泡 --ob-chat-bubble */
  bubble: string;
  /** 导航栏底色：仅 Android 使用（iOS 用系统模糊材质）；Android 没有实时模糊，半透明会让滑过的正文与标题叠在一起，所以用不透明画布色 */
  glass: string;
  text: string;
  textStrong: string;
  subtle: string;
  muted: string;
  disabled: string;
  /** 分隔线 --ob-border */
  line: string;
  /** 控件描边 --ob-border-strong */
  border: string;
  hover: string;
  /** 中性选中态 */
  selected: string;
  /** 主按钮（实色）与其文字 */
  button: string;
  buttonText: string;
  blue: string;
  success: string;
  warning: string;
  danger: string;
  violet: string;
  /** 状态色的轻底（--ob-semantic-soft-alpha） */
  blueSoft: string;
  successSoft: string;
  warningSoft: string;
  dangerSoft: string;
  violetSoft: string;
  mask: string;
  shadow: string;
};

export const lightTheme: Theme = {
  dark: false,
  bg: '#f8f8f8',
  sidebar: '#f0f0f0',
  panel: '#ffffff',
  raised: '#f6f6f6',
  surfaceSoft: '#f1f1f2',
  codeBg: '#f1f1f2',
  bubble: '#eeeeef',
  glass: '#f8f8f8',
  text: '#27272a',
  textStrong: '#18181b',
  subtle: '#707078',
  muted: '#91919a',
  disabled: '#a8a8b0',
  line: 'rgba(24,24,27,0.08)',
  border: 'rgba(24,24,27,0.16)',
  hover: 'rgba(24,24,27,0.04)',
  selected: 'rgba(24,24,27,0.065)',
  button: '#18181b',
  buttonText: '#f8f8f8',
  blue: '#2563eb',
  success: '#228339',
  warning: '#9b681a',
  danger: '#c2414b',
  violet: '#7c3aed',
  blueSoft: 'rgba(37,99,235,0.10)',
  successSoft: 'rgba(34,131,57,0.10)',
  warningSoft: 'rgba(155,104,26,0.12)',
  dangerSoft: 'rgba(194,65,75,0.10)',
  violetSoft: 'rgba(124,58,237,0.12)',
  mask: 'rgba(0,0,0,0.28)',
  shadow: '#000000',
};

export const darkTheme: Theme = {
  dark: true,
  bg: '#161616',
  sidebar: '#161616',
  panel: '#202020',
  raised: '#2b2b2b',
  surfaceSoft: '#303030',
  codeBg: '#262626',
  bubble: '#27272a',
  glass: '#161616',
  text: '#dedee3',
  textStrong: '#f4f4f5',
  subtle: '#a3a3ad',
  muted: '#858590',
  disabled: '#666670',
  line: 'rgba(255,255,255,0.09)',
  border: 'rgba(255,255,255,0.18)',
  hover: 'rgba(255,255,255,0.06)',
  selected: 'rgba(255,255,255,0.08)',
  button: '#f4f4f5',
  buttonText: '#161616',
  blue: '#60a5fa',
  success: '#6ee7a2',
  warning: '#f6c453',
  danger: '#fb8585',
  violet: '#b49af8',
  blueSoft: 'rgba(96,165,250,0.13)',
  successSoft: 'rgba(110,231,162,0.13)',
  warningSoft: 'rgba(246,196,83,0.13)',
  dangerSoft: 'rgba(251,133,133,0.13)',
  violetSoft: 'rgba(180,154,248,0.14)',
  mask: 'rgba(0,0,0,0.55)',
  shadow: '#000000',
};

/** 字号与行高。正文 15.5/26，次要 13.5，最小 12；不为紧凑缩小字号。 */
export const type = {
  largeTitle: 32,
  title: 16,
  body: 15.5,
  bodyLine: 26,
  bubble: 15.5,
  bubbleLine: 24,
  small: 13.5,
  smallLine: 20,
  tiny: 12,
  tinyLine: 16,
  mono: 12.8,
  monoLine: 20,
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 };

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, bubble: 20, sheet: 30, pill: 999 };

/** 正文阅读宽度上限（平板中栏），避免整屏长行。 */
export const readingWidth = 680;

export const fonts = {
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
};

/** 卡片与浮层阴影（iOS 用 shadow*，Android 用 elevation）。 */
export function elevation(theme: Theme, level: 'card' | 'pop' = 'pop') {
  const pop = level === 'pop';
  return Platform.select({
    ios: { shadowColor: theme.shadow, shadowOpacity: theme.dark ? 0.36 : pop ? 0.1 : 0.04, shadowRadius: pop ? 14 : 4, shadowOffset: { width: 0, height: pop ? 6 : 1 } },
    android: { elevation: pop ? 6 : 1 },
    default: {},
  });
}

/** 平板/宽窗口断点：>= 900 显示侧栏（双栏），>= 1180 额外显示右侧检查器（三栏）。 */
export const breakpoints = { split: 900, inspector: 1180 };

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}

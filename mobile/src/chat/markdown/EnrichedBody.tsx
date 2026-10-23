/**
 * 正文渲染器实现 #1：react-native-enriched-markdown（md4c 原生解析 + 原生文本排版）。
 * - flavor="github"：表格、任务列表、带复制按钮的代码块、$$ 块公式；
 * - md4cFlags.hardSoftBreaks：对齐 Web markdown-it 的 breaks:true（单个换行即换行）；
 * - streamingAnimation：流式时新增尾部淡入；
 * - 颜色取自 ui/theme（Web theme-tokens 的 chat 角色）。
 */
import React, { memo, useMemo } from 'react';
import { Linking } from 'react-native';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';

import type { Theme } from '../../ui/theme';
import { fonts, type as typeScale } from '../../ui/theme';
import { preprocessForMd4c, type BodyRenderer, type BodyRendererProps } from './BodyRenderer';

const styleCache = new WeakMap<Theme, MarkdownStyle>();

export function markdownStyleFor(theme: Theme): MarkdownStyle {
  const cached = styleCache.get(theme);
  if (cached) return cached;
  const base = { fontSize: typeScale.body, lineHeight: typeScale.bodyLine, color: theme.text };
  const style: MarkdownStyle = {
    paragraph: { ...base, marginTop: 0, marginBottom: 10 },
    // 标题：方向稿 h3 = 16.5/650，上 16 下 6；更高级标题递增字号，不加粗到喧宾
    h1: { fontSize: 20, lineHeight: 28, color: theme.textStrong, fontWeight: '700', marginTop: 18, marginBottom: 8 },
    h2: { fontSize: 18, lineHeight: 26, color: theme.textStrong, fontWeight: '700', marginTop: 18, marginBottom: 6 },
    h3: { fontSize: 16.5, lineHeight: 24, color: theme.textStrong, fontWeight: '600', marginTop: 16, marginBottom: 6 },
    h4: { fontSize: 15.5, lineHeight: 24, color: theme.textStrong, fontWeight: '600', marginTop: 12, marginBottom: 4 },
    strong: { color: theme.textStrong },
    em: { color: theme.text },
    link: { color: theme.blue, underline: false },
    // 行内代码：hover 底、等宽 13.5（圆角由原生实现决定，库未暴露 borderRadius）
    code: { fontFamily: fonts.mono, fontSize: 13.5, color: theme.textStrong, backgroundColor: theme.hover, borderColor: 'transparent' },
    // 代码块：codeBg 底、圆角 12、无描边；github flavor 自带顶部语言标签 + 复制按钮
    codeBlock: {
      fontFamily: fonts.mono,
      fontSize: typeScale.mono,
      lineHeight: 20.5,
      color: theme.text,
      backgroundColor: theme.codeBg,
      borderColor: 'transparent',
      borderWidth: 0,
      borderRadius: 12,
      padding: 12,
      marginTop: 6,
      marginBottom: 12,
      syntaxColors: theme.dark
        ? { keyword: '#c4a1ff', string: '#a5d6a7', number: '#f6c453', comment: '#82828a', function: '#90caf9', type: '#f6c453', constant: '#fbad66', property: '#90caf9', tag: '#c4a1ff', attribute: '#f6c453' }
        : { keyword: '#7c3aed', string: '#228339', number: '#ac4f00', comment: '#95959a', function: '#2563eb', type: '#9b681a', constant: '#ac4f00', property: '#2563eb', tag: '#7c3aed', attribute: '#9b681a' },
    },
    blockquote: { ...base, color: theme.subtle, borderColor: theme.border, borderWidth: 3, backgroundColor: 'transparent', padding: 4, marginBottom: 10 },
    list: { ...base, bulletColor: theme.muted, markerColor: theme.subtle, gapWidth: 8, marginLeft: 20, marginBottom: 10, itemSpacing: 3 },
    table: {
      fontSize: 14,
      lineHeight: 20,
      color: theme.text,
      headerBackgroundColor: theme.codeBg,
      headerTextColor: theme.textStrong,
      borderColor: theme.line,
      borderWidth: 1,
      borderRadius: 12,
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 6,
      marginBottom: 12,
    },
    thematicBreak: { color: theme.line, height: 1, marginTop: 12, marginBottom: 12 },
    math: { fontSize: 16, color: theme.text, backgroundColor: 'transparent', padding: 6, marginBottom: 10, textAlign: 'center' },
    inlineMath: { color: theme.text },
    taskList: { checkedColor: theme.button, borderColor: theme.border, checkmarkColor: theme.buttonText },
  };
  styleCache.set(theme, style);
  return style;
}

const md4cFlags = { hardSoftBreaks: true, latexMath: true };
const streamingConfig = undefined;

function EnrichedBodyComponent({ markdown, streaming, theme, selectable = true, onLinkPress, onImagePress, imageRequestHeaders }: BodyRendererProps) {
  const source = useMemo(() => preprocessForMd4c(markdown).replace(/\n+$/, ''), [markdown]);
  const markdownStyle = markdownStyleFor(theme);
  return (
    <EnrichedMarkdownText
      flavor="github"
      markdown={source}
      markdownStyle={markdownStyle}
      md4cFlags={md4cFlags}
      selectable={selectable}
      selectionColor={theme.dark ? 'rgba(96,165,250,0.35)' : 'rgba(37,99,235,0.25)'}
      streamingAnimation={streaming}
      streamingConfig={streamingConfig}
      enableTaskListItemToggle={false}
      allowTrailingMargin={false}
      onLinkPress={({ url }) => (onLinkPress ? onLinkPress(url) : void Linking.openURL(url))}
      {...(onImagePress ? { onImagePress: ({ url }: { url: string }) => onImagePress(url) } : {})}
      {...(imageRequestHeaders ? { imageRequestHeaders } : {})}
    />
  );
}

export const EnrichedBody = memo(EnrichedBodyComponent);

export const enrichedRenderer: BodyRenderer = {
  name: 'react-native-enriched-markdown',
  Component: EnrichedBody,
  preprocess: preprocessForMd4c,
};

/**
 * “正文渲染器”接口（设计 5.3）：消息行只依赖这个接口，输入是 Markdown 块和流式状态，输出是视图；
 * 高度变化由视图自身布局驱动（列表库测量），不需要回调。
 * 第一个实现：react-native-enriched-markdown（EnrichedBody.tsx）。
 * 某类块不达标时，可以按 blockKind 换实现（例如表格/公式改为原生自定义组件），列表和数据层不受影响。
 */
import type React from 'react';

import type { Theme } from '../../ui/theme';
import { fixCjkEmphasis } from './cjkEmphasis';

export type BodyBlockKind = 'paragraph' | 'code' | 'math' | 'table' | 'quote' | 'list' | 'heading' | 'rule' | 'blank';

export type BodyRendererProps = {
  markdown: string;
  blockKind: BodyBlockKind | string;
  /** 正在流式生成（只有当前轮的最后一块会是 true） */
  streaming: boolean;
  theme: Theme;
  selectable?: boolean;
  onLinkPress?: (url: string) => void;
  /** b2：点按正文里的图片（看大图） */
  onImagePress?: (url: string) => void;
  /** b2：加载正文图片时携带的请求头（App 令牌，读取会话产物图片） */
  imageRequestHeaders?: Record<string, string>;
};

export type BodyRenderer = {
  name: string;
  Component: React.ComponentType<BodyRendererProps>;
  /** 送入渲染前的统一预处理（CJK 强调、旧式公式等），便于单测与 Web 对照 */
  preprocess(markdown: string): string;
};

const FENCE_RE = /(^|\n)( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2?\3[ \t]*(?=\n|$)|$)/g;

/** 对代码围栏外的文本做变换。 */
export function outsideCode(text: string, transform: (segment: string) => string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(FENCE_RE)) {
    const start = match.index ?? 0;
    out += transform(text.slice(last, start)) + match[0];
    last = start + match[0].length;
  }
  return out + transform(text.slice(last));
}

/**
 * 与 Web markdown.js 对齐的预处理：
 * 1. normalizeLegacyMathBlocks：独占一行的 “[ … ]” 视为 \[ … \]；
 * 2. markdown-it-texmath 支持 \[ … \] 与 \( … \)，md4c 只认 $ / $$，这里转换分隔符；
 * 3. fixCjkEmphasis：按 markdown-it-cjk-friendly 的配对结果，把 md4c 不认的 CJK 标点边界定界符挪到标点外侧
 *    （只改写已成对的定界符，流式中的半截文本安全）。
 */
export function preprocessForMd4c(markdown: string): string {
  return outsideCode(String(markdown || ''), (segment) =>
    fixCjkEmphasis(
      segment
        .replace(/(^|\n)[ \t]*\[[ \t]*\n([\s\S]*?)\n[ \t]*\][ \t]*(?=\n|$)/g, (_m, before, formula) => `${before}$$\n${formula}\n$$`)
        .replace(/(^|\n)[ \t]*\\\[[ \t]*\n?([\s\S]*?)\n?[ \t]*\\\][ \t]*(?=\n|$)/g, (_m, before, formula) => `${before}$$\n${formula.trim()}\n$$`)
        .replace(/\\\((.+?)\\\)/g, (_m, formula) => `$${formula.trim()}$`),
    ),
  );
}

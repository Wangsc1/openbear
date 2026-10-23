/**
 * 行视图共享的动态状态（行组件用 memo 按行对象比较，这些会变化但不属于行数据的状态走 Context）：
 * 运行中（禁用“从此处重来”）、重试请求中、服务器地址与认证头（图片/产物）、选择模式、展开的分组。
 */
import { createContext, useContext } from 'react';

export type ChatRowContextValue = {
  uuid: string;
  running: boolean;
  retryPending: { waitId: string; action: 'now' | 'cancel' } | null;
  baseUrl: string;
  headers: Record<string, string>;
  selecting: boolean;
  deletingTurn: string;
};

export const ChatRowContext = createContext<ChatRowContextValue>({
  uuid: '', running: false, retryPending: null, baseUrl: '', headers: {}, selecting: false, deletingTurn: '',
});

export function useChatRowContext() {
  return useContext(ChatRowContext);
}

/** 正文里的服务器相对地址（/api/...）改成绝对地址，原生 Markdown 视图才能加载图片。 */
export function absolutizeMarkdown(markdown: string, baseUrl: string): string {
  if (!baseUrl || !markdown.includes('](/api/')) return markdown;
  return markdown.replace(/\]\(\s*<?\/api\//g, `](${baseUrl.replace(/\/+$/, '')}/api/`);
}

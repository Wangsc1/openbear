/**
 * 工具名 -> 展示类别的纯规则（不依赖 React Native，node --test 可直接测试；图标在 toolKinds.ts 里补上）。
 *   Read / Grep / Glob / LS                    -> 读取
 *   Bash / Process                             -> 终端
 *   web_search / web_fetch（含 mcp__x__ 前缀）、WebSearch / WebExtract / WebFetch -> 搜索
 *   Edit / Write / EditBatch / MultiEdit / NotebookEdit -> 编辑
 *   Agent（含 AgentContinue / AgentMessage / AgentStop） -> 助手
 *   其他                                        -> 工具
 */
export type ToolKindKey = 'read' | 'terminal' | 'search' | 'edit' | 'agent' | 'tool';

export const TOOL_KIND_LABELS: Record<ToolKindKey, string> = {
  read: '读取',
  terminal: '终端',
  search: '搜索',
  edit: '编辑',
  agent: '助手',
  tool: '工具',
};

const BY_NAME: Record<string, ToolKindKey> = {
  read: 'read',
  grep: 'read',
  glob: 'read',
  ls: 'read',
  bash: 'terminal',
  process: 'terminal',
  web_search: 'search',
  web_fetch: 'search',
  websearch: 'search',
  webfetch: 'search',
  webextract: 'search',
  edit: 'edit',
  write: 'edit',
  editbatch: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  agent: 'agent',
  agentcontinue: 'agent',
  agentmessage: 'agent',
  agentstop: 'agent',
};

/** 去掉 MCP 前缀（mcp__parrot__web_search -> web_search）并小写。 */
export function normalizeToolName(name: string): string {
  const raw = String(name || '').trim();
  const mcp = /^mcp__.+?__(.+)$/.exec(raw);
  return (mcp ? mcp[1] : raw).toLowerCase();
}

export function toolKindKey(name: string): ToolKindKey {
  return BY_NAME[normalizeToolName(name)] || 'tool';
}

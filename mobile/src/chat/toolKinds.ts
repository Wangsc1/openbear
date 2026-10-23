/**
 * 工具名 -> 展示类别 + 图标（对话流计数、时间线、详情面板共用同一套规则；规则本身在 toolKindRules.ts）。
 *   Read/Grep/Glob -> 读取，Bash -> 终端，web_search/web_fetch -> 搜索，Edit/Write -> 编辑，Agent -> 助手，其他 -> 工具。
 * 思考（reasoning）与交互问答不是工具调用，单独导出 REASONING_KIND / INTERACTION_KIND。
 */
import { Bot, Brain, FileText, Globe, MessageCircleQuestion, PenLine, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react-native';

import { TOOL_KIND_LABELS, toolKindKey, type ToolKindKey } from './toolKindRules';

export type { ToolKindKey } from './toolKindRules';
export type ToolKind = { key: ToolKindKey; label: string; icon: LucideIcon };

const ICONS: Record<ToolKindKey, LucideIcon> = {
  read: FileText,
  terminal: SquareTerminal,
  search: Globe,
  edit: PenLine,
  agent: Bot,
  tool: Wrench,
};

const KINDS = Object.fromEntries(
  (Object.keys(TOOL_KIND_LABELS) as ToolKindKey[]).map((key) => [key, { key, label: TOOL_KIND_LABELS[key], icon: ICONS[key] }]),
) as Record<ToolKindKey, ToolKind>;

export function toolKind(name: string): ToolKind {
  return KINDS[toolKindKey(name)];
}

export const REASONING_KIND = { key: 'reasoning' as const, label: '思考', icon: Brain };
export const INTERACTION_KIND = { key: 'interaction' as const, label: '交互问答', icon: MessageCircleQuestion };

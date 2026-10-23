/**
 * 时间线展示辅助：工具类别（规则唯一来源是 toolKindRules.ts，详情面板图标在 toolKinds.ts）、时长与 token 格式、连续读取合并。
 * 本文件被数据层 rows.ts 引用，只能依赖纯 TS 模块，不能引入 react-native。
 */
import type { ChatRow, ToolRow } from '../data/rows';
import { TOOL_KIND_LABELS, toolKindKey, type ToolKindKey } from './toolKindRules';

export type ToolCategoryKey = ToolKindKey;

export type ToolCategory = { key: ToolCategoryKey; label: string };

/** 去掉批量后缀（“Bash +2” -> “Bash”）与 MCP 前缀（mcp__parrot__web_fetch -> web_fetch）。 */
export function baseToolName(name: string): string {
  return String(name || '').trim().replace(/\s*\+\d+$/, '').replace(/^mcp__.+?__/, '');
}

export function toolCategory(name: string): ToolCategory {
  const key = toolKindKey(baseToolName(name));
  return { key, label: TOOL_KIND_LABELS[key] };
}

export function toolCategoryLabel(key: ToolCategoryKey): string {
  return TOOL_KIND_LABELS[key];
}

/** 时长：<1s “0.4s”，<60s “12s”，<60m “4m”/“4m12s”，否则 “1h3m”（tabular 显示）。 */
export function shortDuration(ms: number): string {
  const v = Number(ms || 0);
  if (!(v >= 50)) return '';
  if (v < 1000) return `${Math.max(0.1, Math.round(v / 100) / 10)}s`;
  const s = Math.floor(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** token 数：128000 -> 128k，3100 -> 3.1k，1960832 -> 1.96M。 */
export function shortTokens(n: number): string {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

// ---------------------------------------------------------------- 展示层分组：连续读取步骤合并

function groupable(row: ChatRow): row is ToolRow {
  return row.type === 'tool' && row.status === 'ok' && toolCategory(row.title).key === 'read';
}

const groupCache = new WeakMap<ToolRow, ToolRow>();

function groupRow(members: ToolRow[]): ToolRow {
  const first = members[0];
  const cached = groupCache.get(first);
  if (cached?.group && cached.group.length === members.length && cached.group.every((m, i) => m === members[i])) return cached;
  const row: ToolRow = { ...first, durationMs: members.reduce((n, m) => n + (m.durationMs || 0), 0), group: members };
  groupCache.set(first, row);
  return row;
}

/**
 * 同一轮里相邻的、已完成的读取步骤（≥2 个）合并成一行“读取 N 个文件”。
 * 纯展示层：合并行沿用第一步的 key（行身份稳定），成员不变时返回同一个对象（memo 命中）；
 * 没有可合并的步骤时原数组原样返回。
 */
export function groupReadSteps(rows: ChatRow[], expandedGroups?: ReadonlySet<string>): ChatRow[] {
  let out: ChatRow[] | null = null;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (groupable(row)) {
      let j = i + 1;
      while (j < rows.length && groupable(rows[j]) && rows[j].turnKey === row.turnKey) j += 1;
      if (j - i >= 2) {
        if (!out) out = rows.slice(0, i);
        const members = rows.slice(i, j) as ToolRow[];
        const grouped = groupRow(members);
        // b2：展开的分组（“共 N 次，展开逐个看”）——分组行保留并标记展开，成员逐行跟在后面（成员 key 不变）
        if (expandedGroups?.has(grouped.key)) {
          out.push({ ...grouped, groupExpanded: true });
          for (const m of members) out.push({ ...m, key: `${m.key}~m` });
        } else out.push(grouped);
        i = j;
        continue;
      }
    }
    if (out) out.push(row);
    i += 1;
  }
  return out ?? rows;
}

/** 文件路径/预览 -> 短名（release.py）。 */
export function shortObjectName(text: string): string {
  const value = String(text || '').trim();
  if (/^[\w./~-]+$/.test(value) && value.includes('/')) return value.slice(value.lastIndexOf('/') + 1) || value;
  return value;
}

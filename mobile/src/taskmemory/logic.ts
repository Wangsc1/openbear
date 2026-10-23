/**
 * 任务记忆（B4-09～B4-22）的纯逻辑：复用 Web taskMemoryInjection.js / taskMemoryUiState.js / taskMemoryRequestGate.js，
 * 并补充 TaskMemoryDrawer.vue 里写在组件内的小函数（来源、状态、校验、空态文案）。
 */
// @ts-ignore - JS module without types
import * as injection from '@openbear/web/views/consoleView/taskMemoryInjection.js';
// @ts-ignore
import * as uiState from '@openbear/web/views/consoleView/taskMemoryUiState.js';
// @ts-ignore
import * as gate from '@openbear/web/views/consoleView/taskMemoryRequestGate.js';

import { utf8Bytes } from '../panel/format';

export type ScopeType = 'conversation' | 'agent_task';

export type TaskMemoryItem = {
  memoryUuid: string;
  name: string;
  description?: string;
  body?: string;
  autoReinjectCatalog?: boolean;
  visibleToAgents?: boolean;
  revision: number;
  sizeBytes?: number;
  createdBy?: string;
  updatedAt?: number;
  deletedAt?: number;
  sourceTurnUuid?: string;
  sourceRunUuid?: string;
  [key: string]: any;
};

export type AgentTask = { taskUuid: string; title?: string; name?: string; status?: string; updatedAt?: number; [key: string]: any };

export type InjectionPreview = { text: string; tokens: number; maxTokens: number; shortBodyMaxChars: number; includedCount: number | null; omittedCount: number };

export const taskMemoryInjectionPreview: (data: any) => InjectionPreview = injection.taskMemoryInjectionPreview;
export const taskMemoryInjectionUsage: (item: any, shortBodyMaxChars?: number) => string = injection.taskMemoryInjectionUsage;
export const taskMemoryMutationRecovery: (error: any) => { kind: string; resetEditor: boolean; refresh: boolean; message: string } = uiState.taskMemoryMutationRecovery;
export const createTaskMemoryRequestGate: () => {
  capture(identity: any, channel?: string): any;
  isCurrent(token: any, identity: any): boolean;
  invalidate(): number;
  dispose(): void;
} = gate.createTaskMemoryRequestGate;

export const PAGE_SIZE = 50;
export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 200;
export const BODY_MAX_BYTES = 16 * 1024;

export function statusLabel(status: string | undefined): string {
  return (
    ({
      queued: '排队中',
      running: '执行中',
      paused: '已暂停',
      needs_openbear_control: '等待控制',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '已中断',
    } as Record<string, string>)[String(status || '')] || String(status || '未知')
  );
}

export function sourceLabel(item: { createdBy?: string } | null | undefined): string {
  const actor = String(item?.createdBy || '');
  if (actor.startsWith('web:') || actor.startsWith('app:')) return '手动创建';
  if (actor === 'main-controller') return '助手记录';
  if (actor.startsWith('agent:')) return 'Agent 记录';
  return '系统记录';
}

export function taskLabel(task: AgentTask | null | undefined): string {
  return String(task?.title || task?.name || '未命名任务');
}

/** 名称、说明、更新时间按 Web 的 formatDate：月-日 时:分。 */
export function formatDate(timestamp: number | undefined): string {
  const value = Number(timestamp || 0);
  if (!value) return '—';
  const d = new Date(value * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type MemoryForm = {
  memoryUuid: string;
  name: string;
  description: string;
  body: string;
  autoReinjectCatalog: boolean;
  visibleToAgents: boolean;
  revision: number;
};

export function emptyForm(): MemoryForm {
  return { memoryUuid: '', name: '', description: '', body: '', autoReinjectCatalog: true, visibleToAgents: false, revision: 0 };
}

export function formFromDetail(detail: TaskMemoryItem): MemoryForm {
  return {
    memoryUuid: detail.memoryUuid || '',
    name: detail.name || '',
    description: detail.description || '',
    body: detail.body || '',
    autoReinjectCatalog: Boolean(detail.autoReinjectCatalog),
    visibleToAgents: Boolean(detail.visibleToAgents),
    revision: Number(detail.revision || 0),
  };
}

export type FormErrors = { name?: string; description?: string; body?: string };

/** 与 Web saveMemory 的校验一致（名称必填 ≤80、说明 ≤200、正文 ≤16 KiB UTF-8）。 */
export function validateForm(form: MemoryForm): FormErrors {
  const errors: FormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = '名称不能为空';
  else if (Array.from(name).length > NAME_MAX) errors.name = `名称最多 ${NAME_MAX} 个字符`;
  if (Array.from(form.description.trim()).length > DESCRIPTION_MAX) errors.description = `说明最多 ${DESCRIPTION_MAX} 个字符`;
  if (utf8Bytes(form.body) > BODY_MAX_BYTES) errors.body = '正文最多 16 KiB（UTF-8）';
  return errors;
}

export function mutationPayload(form: MemoryForm, scope: { scopeType: ScopeType; taskUuid?: string }) {
  return {
    scopeType: scope.scopeType,
    ...(scope.scopeType === 'agent_task' ? { taskUuid: scope.taskUuid } : {}),
    name: form.name.trim(),
    description: form.description.trim(),
    body: String(form.body || ''),
    autoReinjectCatalog: Boolean(form.autoReinjectCatalog),
    ...(scope.scopeType === 'conversation' ? { visibleToAgents: Boolean(form.visibleToAgents) } : {}),
  };
}

export function scopeParams(scope: { scopeType: ScopeType; taskUuid?: string }, extra: Record<string, unknown> = {}) {
  return { scopeType: scope.scopeType, ...(scope.scopeType === 'agent_task' ? { taskUuid: scope.taskUuid } : {}), ...extra };
}

export function emptyText(tab: ScopeType, hasTask: boolean, query: string): { title: string; description: string } {
  if (tab === 'agent_task' && !hasTask) return { title: '暂无 Agent 任务', description: '此会话中的 Agent 开始工作后，可在这里选择任务并查看记忆。' };
  if (query.trim()) return { title: '没有找到匹配的记忆', description: '试试其他关键词，或清空搜索查看全部。' };
  return { title: '还没有记忆', description: '保存本会话的资料和执行偏好，不重复记录任务进度。' };
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / PAGE_SIZE));
}

/** 适配 HttpError(status, body) 为 Web 的 axios 错误形状，供 taskMemoryMutationRecovery 判断 409/404。 */
export function asAxiosError(error: any) {
  return { ...error, response: { status: Number(error?.status ?? error?.response?.status ?? 0), data: error?.body ?? error?.response?.data } };
}

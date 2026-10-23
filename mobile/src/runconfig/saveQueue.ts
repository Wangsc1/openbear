/**
 * 会话运行配置的串行保存队列（B3-34；B1-62 要求输入区与会话属性共用同一个队列）。
 *
 * - 队列本身是 Web 的 createRunConfigSaveQueue（runConfigState.js）：同一会话的修改按点击顺序逐个发到服务端，
 *   不同会话互不影响；每个响应都要带完整的 runConfig 快照（runConfigFromResponse 校验）才算保存成功。
 * - App 里只有一个队列实例（模块级）。保存成功后按会话 UUID 广播新快照：输入区胶囊、运行配置面板、
 *   会话属性（B1）都订阅 onRunConfigSaved()，谁改的都能立刻看到同一份结果。
 *
 * B1 用法：
 *   import { saveConversationRunConfig, onRunConfigSaved } from '../runconfig';
 *   await saveConversationRunConfig(api, uuid, { model: 'OpenAI/gpt-5' });   // 一次一项，也可以多项（按字段顺序逐个排队）
 */
import type { OpenBearApi } from '../transport/apiAdapter';
import { conversationRequestsForPatch, createRunConfigSaveQueue, type RunConfig } from './logic';

type Listener = (runConfig: any, response: any) => void;
const listeners = new Map<string, Set<Listener>>();

export const runConfigQueue = createRunConfigSaveQueue({
  isCurrent: () => true,
  apply: (runConfig: any, response: any) => {
    const set = listeners.get(String(runConfig?.conversationUuid || ''));
    if (set) for (const fn of [...set]) fn(runConfig, response);
  },
});

/** 订阅某会话保存成功后的完整 runConfig 快照；返回取消订阅。 */
export function onRunConfigSaved(conversationUuid: string, listener: Listener): () => void {
  const key = String(conversationUuid || '');
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (!set!.size) listeners.delete(key);
  };
}

/**
 * 保存一项（或几项）修改：每项一个请求，按顺序进队列；返回最后一个响应里的 runConfig。
 * 失败时抛错（错误文案用 apiError() 取），队列里后续的修改不受影响。
 */
export async function saveConversationRunConfig(api: OpenBearApi, conversationUuid: string, patch: Partial<RunConfig>): Promise<{ runConfig: any; response: any }> {
  const requests = conversationRequestsForPatch(patch);
  if (!requests.length) throw new Error('nothing_to_save');
  const tasks = requests.map(({ kind, args }) => runConfigQueue.enqueue(conversationUuid, () => (api as any)[kind](conversationUuid, ...args)));
  const results = await Promise.all(tasks);
  const last = results[results.length - 1];
  return { runConfig: last.runConfig, response: last.response };
}

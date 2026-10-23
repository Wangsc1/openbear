/**
 * 会话运行配置的串行保存队列（Web App.vue provide('openbear:property-run-config') + createRunConfigSaveQueue 的同等语义）：
 * 同一会话的模型/思考/Fast/Agent/压缩策略修改按用户顺序依次到达服务器，不同会话互不阻塞。
 * 队列本身在 runconfig/saveQueue（输入区与会话属性共用同一个实例）；这里是会话属性和目录默认配置的取值映射。
 */
import type { OpenBearApi } from '../transport/apiAdapter';
import type { RunConfig } from '../runconfig/RunConfigEditor';
import { saveConversationRunConfig } from '../runconfig/saveQueue';

/** 会话 runConfig 快照 -> RunConfigEditor 的 value（与 Web ConversationPropertiesDialog.modelSettings 相同的取值）。 */
export function runConfigValue(snapshot: Record<string, any> | null): RunConfig {
  if (!snapshot) return {};
  return {
    model: snapshot.model ?? null,
    thinkLevel: snapshot.thinkingLevel || snapshot.effectiveThinkingLevel || snapshot.defaultThinkingLevel || 'off',
    fastMode: snapshot.fastRequested ?? snapshot.fastMode ?? false,
    agentModel: snapshot.agentRunConfig?.model || '',
    agentThinkLevel: snapshot.agentRunConfig?.thinkLevel || '',
    agentFastMode: snapshot.agentRunConfig?.fastMode ?? null,
    contextStrategy: snapshot.contextStrategy || 'sliding_window',
  };
}

/** 保存一项：走输入区共用的串行队列（runconfig/saveQueue），返回校验过的完整快照。 */
export async function saveRunConfigPatch(api: OpenBearApi, uuid: string, patch: Partial<RunConfig>) {
  const { runConfig } = await saveConversationRunConfig(api, uuid, patch);
  return runConfig;
}

/** 目录默认运行配置字段 <-> RunConfig 字段。 */
export const FOLDER_FIELD: Record<keyof RunConfig, string> = {
  model: 'mainModel',
  thinkLevel: 'mainThinkingLevel',
  fastMode: 'mainFastMode',
  agentModel: 'agentModel',
  agentThinkLevel: 'agentThinkLevel',
  agentFastMode: 'agentFastMode',
  contextStrategy: 'contextStrategy',
};

export function folderDefaultsToRunConfig(value: Record<string, any>): RunConfig {
  const out: RunConfig = {};
  for (const [key, field] of Object.entries(FOLDER_FIELD)) if (Object.prototype.hasOwnProperty.call(value || {}, field)) (out as any)[key] = value[field];
  return out;
}

/**
 * 应用 RunConfigEditor 的一项修改到目录本地默认（sparse）。
 * 约定：patch 里某项的值为 undefined 表示“恢复继承”（删除本地设置）；其余值原样作为本地设置。
 */
export function applyFolderPatch(local: Record<string, any>, patch: Partial<RunConfig>): Record<string, any> {
  const next = { ...local };
  for (const [key, value] of Object.entries(patch)) {
    const field = FOLDER_FIELD[key as keyof RunConfig];
    if (!field) continue;
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  return next;
}

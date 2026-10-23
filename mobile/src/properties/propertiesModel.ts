/**
 * 属性页的纯逻辑：目录默认运行配置的校验（与 Web ConversationTree.runDefaultsValidationError 相同的规则）。
 */
import { hasRunDefault, modelThinkingLevels, normalizedRunDefaults } from '../tree/webTree';

type Layers = { local: Record<string, any>; inherited: Record<string, any>; fallback: Record<string, any>; resolved: Record<string, any> };

export function folderRunDefaultsError(local: Record<string, any>, layers: Layers, models: Record<string, any>[]): string {
  const byKey = (key: string) => models.find((m) => m.key === String(key || '')) || null;
  const applied = normalizedRunDefaults({ ...layers, local }, models);
  const mainModel = byKey(applied.mainModel);
  const mainLevels = modelThinkingLevels(mainModel);
  const mainThinking = mainLevels.length ? mainLevels : ['off'];
  const agentKey = applied.agentModel === '' ? applied.mainModel : applied.agentModel;
  const agentModel = byKey(agentKey);
  const agentThinking = modelThinkingLevels(agentModel);
  if (hasRunDefault(local, 'mainModel')) {
    if (typeof local.mainModel !== 'string' || !local.mainModel) return '主会话模型不能留空；可选择模型或恢复继承';
    if (!byKey(local.mainModel)) return `主会话模型 ${local.mainModel} 已不可用，请更换或恢复继承`;
  }
  if (hasRunDefault(local, 'mainThinkingLevel') && (typeof local.mainThinkingLevel !== 'string' || !mainThinking.includes(local.mainThinkingLevel))) {
    return '主会话思考强度不受当前生效模型支持，请重新选择或恢复继承';
  }
  if (hasRunDefault(local, 'mainFastMode')) {
    if (typeof local.mainFastMode !== 'boolean') return '主会话 Fast 必须明确选择开启或关闭';
    if (local.mainFastMode && !mainModel?.supportsFast) return '当前主会话模型不支持 Fast';
  }
  if (hasRunDefault(local, 'agentModel')) {
    if (typeof local.agentModel !== 'string') return 'Agent 模型配置无效';
    if (local.agentModel && !byKey(local.agentModel)) return `Agent 模型 ${local.agentModel} 已不可用，请更换或恢复继承`;
  }
  if (hasRunDefault(local, 'agentThinkLevel') && (typeof local.agentThinkLevel !== 'string' || (local.agentThinkLevel !== '' && !agentThinking.includes(local.agentThinkLevel)))) {
    return 'Agent 思考强度不受当前生效模型支持，请重新选择或恢复继承';
  }
  if (hasRunDefault(local, 'agentFastMode')) {
    if (![true, false, null].includes(local.agentFastMode)) return 'Agent Fast 配置无效';
    if (local.agentFastMode === true && !agentModel?.supportsFast) return '当前 Agent 生效模型不支持 Fast';
  }
  return '';
}

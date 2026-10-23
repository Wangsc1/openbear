/**
 * 待回答交互的纯逻辑（无 React）：在 web userInteractionState / questionnaireState 之上补 App 需要的少量判定。
 * 草稿、校验、答案构造全部直接复用 Web 模块，保证提交给后端的结构与 Web 完全一致。
 */
import { interaction$, questionnaire$ } from '../../data/webLogic';

export type InteractionAction = 'confirm' | 'select' | 'prompt' | 'questionnaire';

export function interactionAction(item: any): InteractionAction {
  const action = String(item?.action || 'confirm').trim().toLowerCase();
  return (['confirm', 'select', 'prompt', 'questionnaire'].includes(action) ? action : 'confirm') as InteractionAction;
}

export const ACTION_NAME: Record<InteractionAction, string> = { confirm: '确认', select: '选择', prompt: '输入', questionnaire: '问卷' };

export function interactionRiskLabel(item: any): { label: string; tone: 'danger' | 'warning' } | null {
  const type = String(item?.type || item?.tone || '').toLowerCase();
  if (type === 'danger') return { label: '高风险操作', tone: 'danger' };
  if (type === 'warning') return { label: '请谨慎确认', tone: 'warning' };
  return null;
}

export function optionLabel(option: any): string {
  if (option && typeof option === 'object') return String(option.label ?? option.text ?? option.value ?? '');
  return String(option ?? '');
}

export function questionId(question: any): string {
  return String(question?.questionId ?? question?.id ?? '').trim();
}

export function questionText(question: any, index: number): string {
  return String(question?.prompt || question?.question || question?.title || question?.label || `问题 ${index + 1}`);
}

export function questionOptionValue(option: any): any {
  if (option && typeof option === 'object') return option.value ?? option.label ?? '';
  return option ?? '';
}

export function isRecommendedOption(question: any, option: any): boolean {
  const values = Array.isArray(question?.recommendation?.values) ? question.recommendation.values : [];
  const value = questionOptionValue(option);
  return values.some((item: any) => Object.is(item, value));
}

/** “仅提交意见，暂不执行”按钮是否出现（Web：确认类或需授权的选择类，且已选中，且有补充文字）。 */
export function showFeedbackAction(item: any, draft: { selectedIndexes: number[]; text: string }): boolean {
  const action = interactionAction(item);
  return (action === 'confirm' || (Boolean(item?.requiresAuthorization) && draft.selectedIndexes.length > 0)) && Boolean(String(draft.text || '').trim());
}

/** 第一个出错题目的 id（问卷校验后聚焦用，按题目顺序）。 */
export function firstQuestionError(questions: any[], errors: Record<string, string>): string {
  for (const question of Array.isArray(questions) ? questions : []) {
    const id = questionId(question);
    if (id && errors[id]) return id;
  }
  return '';
}

/** 提交失败文案（与 Web answerPendingConfirmation 一致）。 */
export function submitErrorText(status: number, code: string, message: string): string {
  if (status === 400) return `回答未能提交：${message || '请检查输入后重试。'}`;
  if (status === 409 && code) return `提交冲突：${message || code}`;
  return `提交失败：${message || '请稍后重试。'}`;
}

export const interactionLogic = interaction$;
export const questionnaireLogic = questionnaire$;

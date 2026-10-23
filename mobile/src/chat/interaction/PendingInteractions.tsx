/**
 * 待回答交互（确认 / 选择 / 输入 / 问卷）——直接在对话里作答（B2-54～B2-68）。
 *
 * 位置：对话页列表区底部、输入卡片正上方（绝对定位在列表容器内，随键盘与输入区一起移动；不改 Composer）。
 * 形态：可展开的卡片栈。默认展开；顶部一行“待你回答 · N 项”可收起成一条，方便回看对话。
 * 草稿按 confirmationId 保存在本组件（收起/展开不丢），答案结构由 web userInteractionState / questionnaireState 构造。
 * 提交：POST /api/conversations/{cid}/confirmations/{id}/answer（带 revision）；成功移除；已被处理/过期（409/404 终态）
 * 时移除并重读会话；其它错误显示在卡片内。
 * 定位（B2-68）：focusId（路由参数 focus）对应的卡片展开、滚到可见并短暂高亮；只聚焦卡片，不弹键盘、不触发按钮。
 */
import { AlertTriangle, Check, ChevronDown, ChevronUp, Eye, EyeOff, MessageCircleQuestion } from 'lucide-react-native';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ConversationStore } from '../../data/conversationStore';
import { Icon, Press, tap } from '../../ui/primitives';
import { elevation, type Theme } from '../../ui/theme';
import { apiError, axiosLikeError, useChatApi } from '../chatApi';
import { enrichedRenderer } from '../markdown/EnrichedBody';
import { withAlpha } from '../rowParts';
import {
  ACTION_NAME,
  firstQuestionError,
  interactionAction,
  interactionLogic as IL,
  interactionRiskLabel,
  isRecommendedOption,
  optionLabel,
  questionId,
  questionnaireLogic as QL,
  questionOptionValue,
  questionText,
  showFeedbackAction,
  submitErrorText,
} from './interactionModel';

type Props = {
  theme: Theme;
  uuid: string;
  store: ConversationStore;
  items: any[];
  /** 列表容器内的底边偏移（输入卡片顶边之上） */
  bottom: number;
  maxHeight: number;
  padH: number;
  focusId?: string;
  onFocusHandled?: () => void;
  /** 卡片栏高度变化（对话列表底部留白用） */
  onHeight?: (height: number) => void;
};

type Draft = { selectedIndexes: number[]; value: string; text: string };

function useNowWhen(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function PendingInteractions({ theme, uuid, store, items, bottom, maxHeight, padH, focusId, onFocusHandled, onHeight }: Props) {
  const api = useChatApi();
  const [open, setOpen] = useState(true);
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [highlight, setHighlight] = useState('');
  const [, force] = useState(0);
  const drafts = useRef(new Map<string, Draft>());
  const qDrafts = useRef(new Map<string, any>());
  const qErrors = useRef(new Map<string, Record<string, string>>());
  const scrollRef = useRef<ScrollView>(null);
  const cardY = useRef(new Map<string, number>());
  const questionY = useRef(new Map<string, number>());
  const inputs = useRef(new Map<string, TextInput | null>());
  const hasExpiry = items.some((item) => Number(item?.expiresAtMs) > 0);
  const now = useNowWhen(hasExpiry);
  const rerender = useCallback(() => force((n) => n + 1), []);

  const draftFor = useCallback((item: any): Draft => {
    const id = String(item.confirmationId);
    let draft = drafts.current.get(id);
    if (!draft) {
      draft = IL.createInteractionDraft(item);
      drafts.current.set(id, draft);
    }
    return draft;
  }, []);
  const qDraftFor = useCallback((item: any) => {
    const id = String(item.confirmationId);
    let draft = qDrafts.current.get(id);
    if (!draft) {
      draft = QL.createQuestionnaireDraft(Array.isArray(item.questions) ? item.questions : []);
      qDrafts.current.set(id, draft);
    }
    return draft;
  }, []);

  // 已不在列表里的草稿清掉
  useEffect(() => {
    const ids = new Set(items.map((item) => String(item.confirmationId)));
    for (const map of [drafts.current, qDrafts.current, qErrors.current]) for (const key of [...map.keys()]) if (!ids.has(key)) map.delete(key);
  }, [items]);

  // 从待处理面板跳过来：展开、滚到卡片、短暂高亮
  useEffect(() => {
    if (!focusId) return undefined;
    if (!items.some((item) => String(item.confirmationId) === focusId)) return undefined;
    setOpen(true);
    setHighlight(focusId);
    const timer = setTimeout(() => {
      const y = cardY.current.get(focusId);
      if (y != null) scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
      onFocusHandled?.();
    }, 260);
    const clear = setTimeout(() => setHighlight(''), 2600);
    return () => {
      clearTimeout(timer);
      clearTimeout(clear);
    };
  }, [focusId, items, onFocusHandled]);

  const submit = useCallback(
    async (item: any, answer: any) => {
      const id = String(item.confirmationId);
      if (!api || submitting[id]) return;
      setSubmitting((s) => ({ ...s, [id]: true }));
      setErrors((e) => {
        const next = { ...e };
        delete next[id];
        return next;
      });
      try {
        await api.answerConversationConfirmation(uuid, id, { ...answer, revision: IL.interactionRevision(item) });
        tap('medium');
        store.removePendingConfirmation(id);
      } catch (error) {
        const like = axiosLikeError(error);
        if (IL.isTerminalInteractionError(like)) {
          store.removePendingConfirmation(id);
          void store.reload();
          return;
        }
        setErrors((e) => ({ ...e, [id]: submitErrorText(Number(like?.response?.status || 0), IL.interactionErrorCode(like), apiError(error)) }));
      } finally {
        setSubmitting((s) => {
          const next = { ...s };
          delete next[id];
          return next;
        });
      }
    },
    [api, uuid, store, submitting],
  );

  const answer = useCallback(
    (item: any, intent: string) => {
      const id = String(item.confirmationId);
      if (submitting[id] || IL.isInteractionExpired(item, Date.now())) return;
      const draft = draftFor(item);
      if (intent !== 'cancel') {
        const error = IL.validateInteractionDraft(item, draft);
        if (error) {
          setErrors((e) => ({ ...e, [id]: error }));
          return;
        }
      }
      void submit(item, IL.buildInteractionAnswer(item, draft, intent));
    },
    [draftFor, submit, submitting],
  );

  const submitQuestionnaire = useCallback(
    (item: any, cancelled: boolean) => {
      const id = String(item.confirmationId);
      if (submitting[id] || IL.isInteractionExpired(item, Date.now())) return;
      const questions = Array.isArray(item.questions) ? item.questions : [];
      const draft = qDraftFor(item);
      if (!cancelled) {
        const errs = QL.validateQuestionnaire(questions, draft);
        qErrors.current.set(id, errs);
        rerender();
        const first = firstQuestionError(questions, errs);
        if (first) {
          const key = `${id}:${first}`;
          const y = (cardY.current.get(id) ?? 0) + (questionY.current.get(key) ?? 0);
          scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
          setTimeout(() => inputs.current.get(key)?.focus(), 280);
          return;
        }
      }
      void submit(item, QL.buildQuestionnaireAnswer(questions, draft, cancelled));
    },
    [qDraftFor, rerender, submit, submitting],
  );

  if (!items.length) return null;
  const first = items[0];
  const headerTitle = String(first?.title || (interactionAction(first) === 'questionnaire' ? '需要你补充一些信息' : '请确认'));

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom, paddingHorizontal: Math.max(10, padH - 8) }]} testID="pending-interactions">
      <View onLayout={(e) => onHeight?.(Math.round(e.nativeEvent.layout.height))} style={[styles.tray, { backgroundColor: theme.panel, borderColor: withAlpha(theme.warning, 0.35), maxHeight }, elevation(theme, 'pop')]}>
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(theme.warning, theme.dark ? 0.08 : 0.05) }]} />
        <Press
          onPress={() => {
            tap('select');
            setOpen((v) => !v);
          }}
          style={styles.trayHead}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`待你回答 ${items.length} 项`}
          testID="pending-toggle"
        >
          <Icon as={MessageCircleQuestion} size={17} color={theme.warning} strokeWidth={2} />
          <Text numberOfLines={1} style={[styles.trayTitle, { color: theme.textStrong }]}>
            {open ? `待你回答 · ${items.length} 项` : headerTitle}
          </Text>
          {!open && items.length > 1 ? <Text style={[styles.trayCount, { color: theme.warning }]}>{items.length} 项</Text> : null}
          <Icon as={open ? ChevronDown : ChevronUp} size={18} color={theme.subtle} />
        </Press>
        {open ? (
          <ScrollView ref={scrollRef} style={styles.trayScroll} contentContainerStyle={styles.trayBody} keyboardShouldPersistTaps="handled" nestedScrollEnabled testID="pending-scroll">
            {items.map((item) => {
              const id = String(item.confirmationId);
              const action = interactionAction(item);
              const expired = IL.isInteractionExpired(item, now);
              const disabled = Boolean(submitting[id]) || expired;
              return (
                <View
                  key={id}
                  onLayout={(e) => cardY.current.set(id, e.nativeEvent.layout.y)}
                  style={[styles.card, { borderColor: highlight === id ? theme.warning : theme.line, backgroundColor: theme.panel }, highlight === id && { borderWidth: 2 }]}
                  testID={`pending-card-${action}`}
                  accessibilityLabel={item.title || '待处理交互'}
                >
                  <CardHead theme={theme} item={item} action={action} expired={expired} now={now} />
                  {expired ? <Text style={[styles.expired, { color: theme.warning, backgroundColor: theme.warningSoft }]}>此交互已过期，等待同步最新状态。</Text> : null}
                  {action === 'questionnaire' ? (
                    <QuestionnaireBody
                      theme={theme}
                      item={item}
                      draft={qDraftFor(item)}
                      errors={qErrors.current.get(id) || {}}
                      disabled={disabled}
                      onChange={(questionKey) => {
                        const errs = qErrors.current.get(id);
                        if (errs && questionKey) delete errs[questionKey];
                        rerender();
                      }}
                      registerY={(qid, y) => questionY.current.set(`${id}:${qid}`, y)}
                      registerInput={(qid, ref) => inputs.current.set(`${id}:${qid}`, ref)}
                    />
                  ) : (
                    <SimpleBody
                      theme={theme}
                      item={item}
                      action={action}
                      draft={draftFor(item)}
                      disabled={disabled}
                      onChange={() => {
                        if (errors[id]) setErrors((e) => {
                          const next = { ...e };
                          delete next[id];
                          return next;
                        });
                        rerender();
                      }}
                    />
                  )}
                  {errors[id] ? <Text style={[styles.error, { color: theme.danger }]} accessibilityRole="alert" testID="pending-error">{errors[id]}</Text> : null}
                  {action === 'questionnaire' ? (
                    <View style={styles.actions}>
                      <Btn theme={theme} label="暂不回答" disabled={disabled} onPress={() => submitQuestionnaire(item, true)} testID="pending-later" />
                      <Btn theme={theme} label={submitting[id] ? '提交中…' : '提交回答'} primary busy={submitting[id]} disabled={disabled} onPress={() => submitQuestionnaire(item, false)} testID="pending-submit" />
                    </View>
                  ) : (
                    <View style={styles.actions}>
                      <Btn theme={theme} label={String(item.cancelText || '暂不回答')} disabled={disabled} onPress={() => answer(item, 'cancel')} testID="pending-later" />
                      {action === 'confirm' ? (
                        <Btn theme={theme} label={IL.interactionRejectActionLabel(draftFor(item))} tone="danger" disabled={disabled} onPress={() => answer(item, 'reject')} testID="pending-reject" />
                      ) : null}
                      {showFeedbackAction(item, draftFor(item)) ? (
                        <Btn theme={theme} label="仅提交意见，暂不执行" disabled={disabled} onPress={() => answer(item, 'feedback')} testID="pending-feedback" />
                      ) : null}
                      <Btn
                        theme={theme}
                        label={IL.interactionPrimaryActionLabel(item, draftFor(item), Boolean(submitting[id]))}
                        primary
                        busy={submitting[id]}
                        disabled={disabled}
                        onPress={() => answer(item, 'confirm')}
                        testID="pending-submit"
                      />
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>
        ) : null}
      </View>
    </View>
  );
}

function CardHead({ theme, item, action, expired, now }: { theme: Theme; item: any; action: string; expired: boolean; now: number }) {
  const risk = interactionRiskLabel(item);
  const expiry = IL.interactionExpiryLabel(item, now);
  return (
    <View style={styles.head}>
      <Text style={[styles.title, { color: theme.textStrong }]}>{item.title || (action === 'questionnaire' ? '需要你补充一些信息' : '请确认')}</Text>
      {action === 'questionnaire' ? <Text style={[styles.sub, { color: theme.subtle }]}>请按实际情况回答；选择题也可以直接填写自己的答案。</Text> : null}
      <View style={styles.metaRow}>
        <Text style={[styles.chip, { color: theme.subtle, backgroundColor: theme.hover }]}>{ACTION_NAME[action as keyof typeof ACTION_NAME]}</Text>
        {expiry ? <Text style={[styles.chip, { color: expired ? theme.danger : theme.subtle, backgroundColor: expired ? theme.dangerSoft : theme.hover }]} testID="pending-expiry">{expiry}</Text> : null}
        {risk ? (
          <Text style={[styles.chip, { color: risk.tone === 'danger' ? theme.danger : theme.warning, backgroundColor: risk.tone === 'danger' ? theme.dangerSoft : theme.warningSoft }]}>{risk.label}</Text>
        ) : null}
      </View>
    </View>
  );
}

function Markdown({ theme, text }: { theme: Theme; text: string }) {
  const Body = enrichedRenderer.Component;
  if (!String(text || '').trim()) return null;
  return (
    <View style={styles.md}>
      <Body markdown={String(text)} blockKind="paragraph" streaming={false} theme={theme} selectable />
    </View>
  );
}

function Choice({ theme, label, description, on, multiple, recommended, disabled, onPress, testID }: {
  theme: Theme; label: string; description?: string; on: boolean; multiple?: boolean; recommended?: boolean; disabled?: boolean; onPress(): void; testID?: string;
}) {
  return (
    <Press
      onPress={() => {
        if (disabled) return;
        tap('select');
        onPress();
      }}
      accessibilityRole={multiple ? 'checkbox' : 'radio'}
      accessibilityState={{ checked: on, disabled }}
      style={[styles.opt, { borderColor: on ? theme.textStrong : theme.border, backgroundColor: theme.panel, opacity: disabled ? 0.6 : 1 }]}
      testID={testID}
    >
      {multiple ? (
        <View style={[styles.box, on ? { backgroundColor: theme.button, borderColor: theme.button } : { borderColor: theme.border }]}>
          {on ? <Icon as={Check} size={13} color={theme.buttonText} strokeWidth={3} /> : null}
        </View>
      ) : (
        <View style={[styles.radio, on ? { borderColor: theme.textStrong, borderWidth: 5 } : { borderColor: theme.border }]} />
      )}
      <View style={styles.optMain}>
        <Text style={[styles.optText, { color: theme.text, fontWeight: on ? '600' : '400' }]}>{label}</Text>
        {description ? <Text style={[styles.optDesc, { color: theme.muted }]}>{description}</Text> : null}
      </View>
      {recommended ? <Text style={[styles.rec, { color: theme.success, backgroundColor: theme.successSoft }]}>推荐</Text> : null}
    </Press>
  );
}

function Field({ theme, label, value, onChange, placeholder, disabled, multiline = true, secure, hint, error, inputRef, testID }: {
  theme: Theme; label?: string; value: string; onChange(v: string): void; placeholder: string; disabled?: boolean; multiline?: boolean;
  secure?: boolean; hint?: string; error?: string; inputRef?: (ref: TextInput | null) => void; testID?: string;
}) {
  const [reveal, setReveal] = useState(false);
  return (
    <View style={styles.field}>
      {label ? <Text style={[styles.fieldLabel, { color: theme.subtle }]}>{label}</Text> : null}
      <View>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChange}
          editable={!disabled}
          multiline={multiline && !secure}
          secureTextEntry={Boolean(secure && !reveal)}
          placeholder={placeholder}
          placeholderTextColor={theme.muted}
          selectionColor={theme.textStrong}
          cursorColor={theme.textStrong}
          textAlignVertical={multiline && !secure ? 'top' : 'center'}
          autoCorrect={!secure}
          autoCapitalize="none"
          style={[styles.input, { color: theme.text, backgroundColor: theme.bg, borderColor: error ? theme.danger : theme.border }, multiline && !secure && styles.inputMulti, secure && { paddingRight: 44 }]}
          testID={testID}
        />
        {secure ? (
          <Press onPress={() => setReveal((v) => !v)} style={styles.eye} accessibilityRole="button" accessibilityLabel={reveal ? '隐藏输入' : '显示输入'}>
            <Icon as={reveal ? EyeOff : Eye} size={18} color={theme.subtle} />
          </Press>
        ) : null}
      </View>
      {error ? <Text style={[styles.hint, { color: theme.danger }]} accessibilityRole="alert">{error}</Text> : hint ? <Text style={[styles.hint, { color: theme.muted }]}>{hint}</Text> : null}
    </View>
  );
}

function SimpleBody({ theme, item, action, draft, disabled, onChange }: { theme: Theme; item: any; action: string; draft: Draft; disabled: boolean; onChange(): void }) {
  const options: any[] = Array.isArray(item.options) ? item.options : [];
  return (
    <>
      <Markdown theme={theme} text={item.body} />
      {action === 'select' ? (
        <>
          {options.map((option, index) => (
            <Choice
              key={`${index}:${optionLabel(option)}`}
              theme={theme}
              label={optionLabel(option)}
              description={option?.description}
              on={draft.selectedIndexes.includes(index)}
              multiple={Boolean(item.multiple)}
              disabled={disabled}
              onPress={() => {
                IL.toggleInteractionOption(item, draft, index);
                onChange();
              }}
              testID={`pending-option-${index}`}
            />
          ))}
          {!item.multiple && draft.selectedIndexes.length ? (
            <Press onPress={() => { IL.clearInteractionSelection(draft); onChange(); }} disabled={disabled} style={styles.link} accessibilityRole="button">
              <Text style={[styles.linkText, { color: theme.subtle }]}>清除选择</Text>
            </Press>
          ) : null}
          <Field
            theme={theme}
            label={draft.selectedIndexes.length ? '补充、限制或修正以上选择' : '也可以不选，直接填写自己的答案'}
            value={draft.text}
            onChange={(v) => { draft.text = v; onChange(); }}
            placeholder="写下更符合你需要的答案"
            disabled={disabled}
            hint={item.requiresAuthorization ? '可按补充内容确认执行，也可仅提交意见。附言授权仅限本次操作。' : undefined}
            testID="pending-text"
          />
        </>
      ) : action === 'prompt' ? (
        <Field
          theme={theme}
          label="你的回答"
          value={draft.value}
          onChange={(v) => { draft.value = v; onChange(); }}
          placeholder={item.sensitive ? '输入内容' : '请输入内容'}
          disabled={disabled}
          secure={Boolean(item.sensitive)}
          multiline
          hint={item.sensitive ? '此输入会原样提交给当前任务，不会显示在公开历史中。' : undefined}
          testID="pending-prompt"
        />
      ) : (
        <Field
          theme={theme}
          label="补充或修改（可选）"
          value={draft.text}
          onChange={(v) => { draft.text = v; onChange(); }}
          placeholder="如需调整原操作，请在这里说明"
          disabled={disabled}
          hint="确认时将按补充内容执行；如尚未决定，请选择“仅提交意见”。"
          testID="pending-text"
        />
      )}
    </>
  );
}

function QuestionnaireBody({ theme, item, draft, errors, disabled, onChange, registerY, registerInput }: {
  theme: Theme; item: any; draft: any; errors: Record<string, string>; disabled: boolean; onChange(questionKey?: string): void;
  registerY(qid: string, y: number): void; registerInput(qid: string, ref: TextInput | null): void;
}) {
  const questions: any[] = Array.isArray(item.questions) ? item.questions : [];
  const [baseY, setBaseY] = useState(0);
  return (
    <>
      <Markdown theme={theme} text={item.body} />
      <View onLayout={(e) => setBaseY(e.nativeEvent.layout.y)} style={{ gap: 10 }}>
        {questions.map((question, qIndex) => {
          const qid = questionId(question) || String(qIndex);
          const ans = QL.ensureQuestionAnswer(draft, question);
          const choice = question?.type === 'choice';
          const error = errors[qid] || '';
          return (
            <View
              key={qid}
              onLayout={(e) => registerY(qid, baseY + e.nativeEvent.layout.y)}
              style={[styles.question, { borderColor: error ? theme.danger : theme.line, backgroundColor: theme.dark ? theme.raised : theme.bg }]}
              testID={`question-${qIndex}`}
            >
              <View style={styles.qHead}>
                <Text style={[styles.qNo, { color: theme.buttonText, backgroundColor: theme.button }]}>{qIndex + 1}</Text>
                <Text style={[styles.qText, { color: theme.textStrong }]}>{questionText(question, qIndex)}</Text>
                <Text style={[styles.qTag, question.required !== false && question.required ? { color: theme.danger, backgroundColor: theme.dangerSoft } : { color: theme.subtle, backgroundColor: theme.hover }]}>
                  {question.required ? '必填' : '选填'}
                </Text>
              </View>
              <Markdown theme={theme} text={question.description} />
              {choice ? (
                <>
                  {(Array.isArray(question.options) ? question.options : []).map((option: any, oIndex: number) => (
                    <Choice
                      key={`${qid}-${oIndex}`}
                      theme={theme}
                      label={optionLabel(option)}
                      description={option && typeof option === 'object' ? String(option.description || '') : ''}
                      on={QL.isQuestionChoiceSelected(draft, question, option)}
                      multiple={Boolean(question.multiple)}
                      recommended={isRecommendedOption(question, option)}
                      disabled={disabled}
                      onPress={() => {
                        QL.toggleQuestionChoice(draft, question, questionOptionValue(option));
                        onChange(qid);
                      }}
                      testID={`q${qIndex}-option-${oIndex}`}
                    />
                  ))}
                  {question.recommendation?.reason ? (
                    <Text style={[styles.reason, { color: theme.subtle, backgroundColor: theme.successSoft }]}>
                      <Text style={{ fontWeight: '600', color: theme.success }}>推荐理由 </Text>
                      {String(question.recommendation.reason)}
                    </Text>
                  ) : null}
                  {!question.multiple && ans.selectedValues.length ? (
                    <Press onPress={() => { QL.clearQuestionChoice(draft, question); onChange(); }} disabled={disabled} style={styles.link} accessibilityRole="button">
                      <Text style={[styles.linkText, { color: theme.subtle }]}>清除选择</Text>
                    </Press>
                  ) : null}
                  <Field
                    theme={theme}
                    label={ans.selectedValues.length ? '补充、限制或修正以上选择' : '也可以不选，直接填写自己的答案'}
                    value={ans.text}
                    onChange={(v) => {
                      ans.text = v;
                      onChange(String(v).trim() ? qid : undefined);
                    }}
                    placeholder="写下更符合你需要的答案"
                    disabled={disabled}
                    error={error}
                    hint={question.required ? '必填：至少选择一项或填写文字。' : '选填：留空也可以提交。'}
                    inputRef={(ref) => registerInput(qid, ref)}
                    testID={`q${qIndex}-text`}
                  />
                </>
              ) : (
                <Field
                  theme={theme}
                  label="你的回答"
                  value={ans.text}
                  onChange={(v) => {
                    ans.text = v;
                    onChange(String(v).trim() ? qid : undefined);
                  }}
                  placeholder="请输入你的回答"
                  disabled={disabled}
                  error={error}
                  hint={question.required ? '必填：请填写文字。' : '选填：留空也可以提交。'}
                  inputRef={(ref) => registerInput(qid, ref)}
                  testID={`q${qIndex}-text`}
                />
              )}
            </View>
          );
        })}
      </View>
    </>
  );
}

function Btn({ theme, label, onPress, primary, tone, disabled, busy, testID }: {
  theme: Theme; label: string; onPress(): void; primary?: boolean; tone?: 'danger'; disabled?: boolean; busy?: boolean; testID?: string;
}) {
  const color = primary ? theme.buttonText : tone === 'danger' ? theme.danger : theme.text;
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      style={[
        styles.btn,
        primary ? [styles.btnPrimary, { backgroundColor: theme.button }] : { backgroundColor: tone === 'danger' ? theme.dangerSoft : theme.hover },
        { opacity: disabled && !busy ? 0.45 : 1 },
      ]}
      testID={testID}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : null}
      <Text numberOfLines={1} style={[styles.btnText, { color }]}>{label}</Text>
    </Press>
  );
}

export function PendingIcon({ theme }: { theme: Theme }) {
  return <Icon as={AlertTriangle} size={14} color={theme.warning} />;
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, zIndex: 15 },
  tray: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  trayHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 14 },
  trayTitle: { flex: 1, fontSize: 14.5, fontWeight: '600' },
  trayCount: { fontSize: 12.5, fontWeight: '600' },
  trayScroll: { flexGrow: 0, flexShrink: 1 },
  trayBody: { paddingHorizontal: 10, paddingBottom: 10, gap: 10 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  head: { gap: 4 },
  title: { fontSize: 15.5, fontWeight: '600', lineHeight: 22 },
  sub: { fontSize: 12.5, lineHeight: 18 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  chip: { fontSize: 11.5, fontWeight: '600', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 9, overflow: 'hidden' },
  expired: { fontSize: 12.5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, overflow: 'hidden' },
  md: { marginBottom: -6 },
  opt: { paddingHorizontal: 12, paddingVertical: 10, minHeight: 44, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 10, overflow: 'hidden' },
  optMain: { flex: 1, minWidth: 0 },
  optText: { fontSize: 14.5, lineHeight: 20 },
  optDesc: { fontSize: 12.5, lineHeight: 17, marginTop: 1 },
  rec: { fontSize: 11, fontWeight: '700', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, overflow: 'hidden' },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5 },
  box: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  link: { alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center', paddingHorizontal: 2 },
  linkText: { fontSize: 13, textDecorationLine: 'underline' },
  field: { gap: 5 },
  fieldLabel: { fontSize: 12.5, fontWeight: '500' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, fontSize: 16, minHeight: 44 },
  inputMulti: { minHeight: 64, maxHeight: 160, paddingTop: 10 },
  eye: { position: 'absolute', right: 2, top: 0, bottom: 0, width: 40, alignItems: 'center', justifyContent: 'center' },
  hint: { fontSize: 12, lineHeight: 17 },
  error: { fontSize: 13, lineHeight: 18 },
  reason: { fontSize: 12.5, lineHeight: 18, padding: 8, borderRadius: 8, overflow: 'hidden' },
  question: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 10, gap: 8 },
  qHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  qNo: { width: 20, height: 20, borderRadius: 10, textAlign: 'center', fontSize: 12, lineHeight: 20, fontWeight: '700', overflow: 'hidden', marginTop: 1 },
  qText: { flex: 1, fontSize: 14.5, fontWeight: '600', lineHeight: 21 },
  qTag: { fontSize: 11, fontWeight: '600', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  btn: { minHeight: 42, borderRadius: 21, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, overflow: 'hidden' },
  btnPrimary: { flexGrow: 1, flexBasis: '100%' },
  btnText: { fontSize: 14.5, fontWeight: '600' },
});

// b2（对话消息与卡片）新增纯逻辑的单测：产物链接切分、引用胶囊解析、交互/问卷答案构造（复用 Web 模块）、
// 隐藏消息（行目标、多选、store 投影过滤）、搜索定位窗口、待回答交互的 WS 消息、读取组展开、Agent 事件行、代码高亮、artifactFiles 替身。
// 运行：node --import ./tests/support/register.mjs --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConversationStore } from '../src/data/conversationStore.ts';
import { artifactFromUrl, splitArtifactPieces, artifactImagesIn, markdownImageUrls } from '../src/artifacts/artifactLinks.ts';
import { highlightLine, chunkLines } from '../src/artifacts/codeHighlight.ts';
import { parseReferenceText, referenceFromUrl, referenceScopeLabel, referenceDisplayText } from '../src/chat/cards/references.ts';
import { firstQuestionError, interactionAction, interactionRiskLabel, isRecommendedOption, showFeedbackAction, submitErrorText, interactionLogic, questionnaireLogic } from '../src/chat/interaction/interactionModel.ts';
import { rowTargetId, withSelection, visibilityTargetPreview, hiddenPreviewText } from '../src/chat/visibility.ts';
import { groupReadSteps } from '../src/chat/timeline.ts';
import { activityEventLine, relevantStepId, toneKey } from '../src/chat/agent/agentModel.ts';
import { artifactFormat, extractArtifactSummary, formatFileSize, artifactSharedPath } from '../src/web-shims/artifactFiles.js';
import { artifactPresentation } from '../src/data/webLogic.ts';

const CID = '1ed749bf-86b2-4ec4-9328-5ca9e283cedf';
const AID = '97a1cb36-9334-4aa5-a2da-b3ec4c883070';

test('artifactFromUrl recognises relative and same-origin artifact content links only', () => {
  const rel = artifactFromUrl(`/api/conversations/${CID}/artifacts/${AID}/content`);
  assert.equal(rel.key, `${CID}:${AID}`);
  assert.equal(rel.metadataUrl, `/api/conversations/${CID}/artifacts/${AID}`);
  assert.equal(rel.downloadUrl, `/api/conversations/${CID}/artifacts/${AID}/content?download=1`);
  assert.equal(rel.download, false);
  assert.equal(artifactFromUrl(`/api/conversations/${CID}/artifacts/${AID}/content?download=1`).download, true);
  assert.ok(artifactFromUrl(`http://127.0.0.1:18971/api/conversations/${CID}/artifacts/${AID}/content`, 'http://127.0.0.1:18971'));
  assert.equal(artifactFromUrl(`https://evil.example/api/conversations/${CID}/artifacts/${AID}/content`, 'http://127.0.0.1:18971'), null);
  assert.equal(artifactFromUrl('/api/conversations/x/artifacts/y/content'), null);
});

test('splitArtifactPieces lifts standalone artifact links into cards and keeps code/inline links', () => {
  const link = `/api/conversations/${CID}/artifacts/${AID}/content`;
  const md = ['结论如下：', '', `📎 [报告.md](${link})`, '', '```', `[不要动](${link})`, '```', `行内 [链接](${link}) 保持。`].join('\n');
  const pieces = splitArtifactPieces(md);
  assert.deepEqual(pieces.map((p) => p.kind), ['md', 'artifact', 'md']);
  assert.equal(pieces[1].label, '报告.md');
  assert.ok(pieces[2].text.includes('[不要动]'));
  assert.ok(pieces[2].text.includes('行内 [链接]'));
  const plain = '没有产物';
  assert.equal(splitArtifactPieces(plain)[0].text, plain);
  const img = `![图](${link}?preview=1) 和 ![外部](https://x.test/a.png)`;
  assert.equal(artifactImagesIn(img).length, 1);
  assert.deepEqual(markdownImageUrls(img), [`${link}?preview=1`, 'https://x.test/a.png']);
});

test('reference capsules parse like web codec (kinds, scopes, mention, code spans ignored)', () => {
  const text = '看 [v0.6.0](openbear://ref/chat/b2979f35-31ad-4052-bbce-6cf7784f92a3?scope=recent&turns=5) 和 [记忆](openbear://ref/mem/12?mode=mention) `[x](openbear://ref/mem/1)`';
  const parts = parseReferenceText(text);
  const refs = parts.filter((p) => p.type === 'reference');
  assert.equal(refs.length, 2);
  assert.equal(refs[0].ref.kind, 'chat');
  assert.equal(referenceScopeLabel(refs[0].ref), '最近5轮');
  assert.equal(referenceScopeLabel(refs[1].ref), '仅提及');
  assert.equal(referenceFromUrl('openbear://ref/turn/abc'), null, 'turn needs itemId');
  assert.equal(referenceFromUrl('openbear://ref/turn/abc/t1')?.itemId, 't1');
  assert.equal(referenceFromUrl('openbear://ref/bogus/1'), null);
  assert.ok(referenceDisplayText(text).startsWith('看 v0.6.0 和 记忆'));
});

test('interaction answers are built by the reused web modules (confirm/select/prompt/questionnaire)', () => {
  const confirm = { confirmationId: 'c1', action: 'confirm', revision: 3 };
  const draft = interactionLogic.createInteractionDraft(confirm);
  assert.equal(interactionLogic.interactionPrimaryActionLabel(confirm, draft), '确认执行');
  assert.equal(showFeedbackAction(confirm, draft), false);
  draft.text = '只改 staging';
  assert.equal(interactionLogic.interactionPrimaryActionLabel(confirm, draft), '按补充内容确认执行');
  assert.equal(interactionLogic.interactionRejectActionLabel(draft), '拒绝并提交说明（不执行）');
  assert.equal(showFeedbackAction(confirm, draft), true);
  assert.equal(interactionLogic.buildInteractionAnswer(confirm, draft, 'confirm').decision, 'confirm_with_changes');
  assert.equal(interactionLogic.buildInteractionAnswer(confirm, draft, 'feedback').decision, 'feedback');
  assert.deepEqual(interactionLogic.buildInteractionAnswer(confirm, draft, 'cancel'), { cancelled: true });
  assert.equal(interactionLogic.interactionRevision(confirm), 3);

  const select = { confirmationId: 's1', action: 'select', options: ['A', { label: 'B', value: 'b' }], requiresAuthorization: true };
  const sd = interactionLogic.createInteractionDraft(select);
  assert.match(interactionLogic.validateInteractionDraft(select, sd), /请选择至少一项/);
  interactionLogic.toggleInteractionOption(select, sd, 1);
  sd.text = '补充';
  assert.equal(showFeedbackAction(select, sd), true);
  const ans = interactionLogic.buildInteractionAnswer(select, sd, 'confirm');
  assert.deepEqual(ans.selectedValues, ['b']);
  assert.equal(ans.decision, 'confirm_with_changes');

  assert.equal(interactionAction({ action: 'PROMPT' }), 'prompt');
  assert.equal(interactionAction({ action: 'weird' }), 'confirm');
  assert.equal(interactionRiskLabel({ type: 'danger' })?.label, '高风险操作');
  assert.equal(interactionLogic.interactionExpiryLabel({ expiresAtMs: 1000 }, 2000), '已过期');
  assert.equal(interactionLogic.interactionExpiryLabel({ expiresAtMs: 2000 + 125_000 }, 2000), '剩余 2 分 5 秒');
  assert.equal(submitErrorText(400, '', 'bad'), '回答未能提交：bad');
  assert.equal(submitErrorText(409, 'x', ''), '提交冲突：x');
  assert.equal(interactionLogic.isTerminalInteractionError({ response: { status: 409, data: { error: 'confirmation_expired' } } }), true);
});

test('questionnaire validation reports the first error in question order', () => {
  const questions = [
    { id: 'q1', type: 'open', required: false },
    { id: 'q2', type: 'choice', required: true, options: [{ label: '甲', value: 'a' }, { label: '乙', value: 'b' }], recommendation: { values: ['b'], reason: 'r' } },
    { id: 'q3', type: 'open', required: true },
  ];
  const draft = questionnaireLogic.createQuestionnaireDraft(questions);
  const errors = questionnaireLogic.validateQuestionnaire(questions, draft);
  assert.deepEqual(Object.keys(errors).sort(), ['q2', 'q3']);
  assert.equal(firstQuestionError(questions, errors), 'q2');
  assert.equal(isRecommendedOption(questions[1], questions[1].options[1]), true);
  questionnaireLogic.toggleQuestionChoice(draft, questions[1], 'b');
  questionnaireLogic.ensureQuestionAnswer(draft, questions[2]).text = '答案';
  assert.deepEqual(questionnaireLogic.validateQuestionnaire(questions, draft), {});
  const answer = questionnaireLogic.buildQuestionnaireAnswer(questions, draft);
  assert.deepEqual(answer.answers[1].selectedValues, ['b']);
  assert.deepEqual(questionnaireLogic.buildQuestionnaireAnswer(questions, draft, true), { cancelled: true });
});

test('visibility helpers: row targets, selection decoration and previews', () => {
  const rows = [
    { key: 'a', type: 'user', turnKey: 't', opId: 'msg:1', text: 'hi', createdAtMs: 0, synthetic: false },
    { key: 'b', type: 'work_summary', turnKey: 't', label: '', stepCount: 0, expanded: false, running: false, workKey: 'w', counts: [] },
    { key: 'c#0', type: 'answer', turnKey: 't', messageId: 'assistant:1', markdown: 'x', blockIndex: 0, blockCount: 2, blockKind: 'paragraph', live: false, error: false },
    { key: 'c#1', type: 'answer', turnKey: 't', messageId: 'assistant:1', markdown: 'y', blockIndex: 1, blockCount: 2, blockKind: 'paragraph', live: false, error: false },
  ];
  assert.equal(rowTargetId(rows[0]), 'msg:1');
  assert.equal(rowTargetId(rows[1]), '');
  assert.equal(rowTargetId(rows[2]), 'assistant:1');
  assert.equal(withSelection(rows, false, new Set(), () => true), rows);
  const sel = withSelection(rows, true, new Set(['assistant:1']), () => true);
  assert.equal(sel[0].selectState, 'off');
  assert.equal(sel[1], rows[1]);
  assert.equal(sel[2].selectState, 'on');
  assert.equal(sel[3].selectHidden, true);
  assert.deepEqual(visibilityTargetPreview({ opType: 'assistant_message', payload: { text: '  多  空格 ' } }), { label: '模型回复', text: '多 空格' });
  assert.equal(hiddenPreviewText({ opType: 'user_message', payload: { text: '原文' } }), '原文');
});

function fakeStore(operations) {
  const api = {
    async state() { return { operations, frameSeq: 10, hasMoreBefore: false, messageVisibility: { conversationUuid: 'c', revision: 1, hiddenIds: [], items: [] }, pendingConfirmations: [{ confirmationId: 'p1', action: 'confirm' }], pendingSteering: [] }; },
    async operations() { return { operations: [] }; },
    async frames() { return { frames: [] }; },
    async operationDetail() { return {}; },
  };
  let handlers = null;
  const socketFactory = (_uuid, _seq, h) => { handlers = h; return { send: () => true, close() {} }; };
  const store = new ConversationStore('c', api, socketFactory, { setTimer: (fn) => { fn(); return 1; }, clearTimer() {} });
  return { store, socket: () => handlers };
}

const op = (opId, opType, displaySeq, payload, extra = {}) => ({ opId, opType, displaySeq, revision: 1, status: 'completed', lifecycle: 'terminal', payload, createdAtMs: displaySeq * 1000, turnUuid: 'turn-1', runRootTurnId: 'turn-1', transcriptMessageIds: [displaySeq], ...extra });

test('store: pending confirmations, steering and visibility from state and WS messages', async () => {
  const ops = [
    op('msg:1', 'user_message', 1, { text: '你好', role: 'user' }),
    op('assistant:1', 'assistant_message', 2, { text: '回答', complete: true }),
  ];
  const { store, socket } = fakeStore(ops);
  await store.open();
  assert.equal(store.snapshot.pendingConfirmations.length, 1);
  const before = store.snapshot.rows.length;
  assert.ok(store.snapshot.rows.some((r) => r.type === 'user' && r.opId === 'msg:1' && r.deleteTraceable === true));
  socket().onMessage({ type: 'web_confirmation', confirmations: [{ confirmationId: 'p1' }, { confirmationId: 'p2', action: 'questionnaire' }] });
  assert.equal(store.snapshot.pendingConfirmations.length, 2);
  store.removePendingConfirmation('p1');
  assert.deepEqual(store.snapshot.pendingConfirmations.map((x) => x.confirmationId), ['p2']);
  socket().onMessage({ type: 'pending_steering', items: [{ id: 's1', text: '插话' }] });
  assert.equal(store.snapshot.pendingSteering.length, 1);
  socket().onMessage({ type: 'pending_steering', action: 'drain', itemIds: ['s1'] });
  assert.equal(store.snapshot.pendingSteering.length, 0);
  // 隐藏回复：行被过滤；旧 revision 被忽略
  socket().onMessage({ type: 'message_visibility.changed', visibility: { conversationUuid: 'c', revision: 2, hiddenIds: ['assistant:1'], items: [{ opId: 'assistant:1', type: 'assistant_message' }] } });
  assert.ok(store.snapshot.rows.length < before);
  assert.ok(!store.snapshot.rows.some((r) => r.type === 'answer'));
  assert.equal(store.isHidden('assistant:1'), true);
  assert.equal(store.applyVisibility({ conversationUuid: 'c', revision: 1, hiddenIds: [], items: [] }), false);
  assert.equal(store.canTargetVisibility('msg:1'), true);
  assert.deepEqual(store.assistantTargets(store.snapshot.rows[0].turnKey), []);
  store.applyVisibility({ conversationUuid: 'c', revision: 3, hiddenIds: [], items: [] });
  assert.ok(store.snapshot.rows.some((r) => r.type === 'answer'));
  assert.deepEqual(store.assistantTargets(store.snapshot.rows[0].turnKey), ['assistant:1']);
  assert.equal(store.turnAnswerMarkdown(store.snapshot.rows[0].turnKey), '回答');
  assert.equal(store.turnList().length, 1);
  store.dispose();
});

test('store: seek window merges older operations and releases them on return', async () => {
  const ops = [op('msg:9', 'user_message', 90, { text: '最新' }, { turnUuid: 't9', runRootTurnId: 't9' })];
  const { store } = fakeStore(ops);
  await store.open();
  const older = [op('msg:2', 'user_message', 20, { text: '很早的消息' }, { turnUuid: 't2', runRootTurnId: 't2' })];
  assert.equal(store.mergeSeekWindow(older, 10, 'msg:404'), false);
  assert.equal(store.mergeSeekWindow(older, 10, 'msg:2'), true);
  assert.equal(store.snapshot.seekActive, true);
  assert.ok(store.rowIndexForOp('msg:2') >= 0);
  store.releaseSeekWindow();
  assert.equal(store.snapshot.seekActive, false);
  assert.equal(store.rowIndexForOp('msg:2'), -1);
  assert.ok(store.rowIndexForOp('msg:9') >= 0);
  store.dispose();
});

test('groupReadSteps expands a merged read group in place with stable member keys', () => {
  const tool = (key, title) => ({ key, type: 'tool', turnKey: 't', opId: key, title, preview: `/a/${key}.py`, status: 'ok', durationMs: 100, inWork: true });
  const rows = [tool('r1', 'Read'), tool('r2', 'Read'), tool('r3', 'Read')];
  const collapsed = groupReadSteps(rows);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].group.length, 3);
  const expanded = groupReadSteps(rows, new Set(['r1']));
  assert.equal(expanded.length, 4);
  assert.equal(expanded[0].groupExpanded, true);
  assert.deepEqual(expanded.slice(1).map((r) => r.key), ['r1~m', 'r2~m', 'r3~m']);
});

test('agent model helpers: event lines, completion-check jumps, tones', () => {
  const line = activityEventLine('task-1', { seq: 7, ts: 1790826324, kind: 'tool_call_started', detail: { name: 'Read', arguments: '{"path":"/x"}' } });
  assert.equal(line.key, 'task-1|7|tool_call_started');
  assert.equal(line.toolName, 'Read');
  assert.match(line.timeLabel, /^\d\d:\d\d:\d\d$/);
  const view = { steps: [
    { id: 's1', required: true, status: 'completed', criteria: [{ required: true, satisfied: true, evidence: [1] }] },
    { id: 's2', required: true, status: 'running', criteria: [{ required: true, satisfied: false, evidence: [] }] },
  ] };
  assert.equal(relevantStepId(view, { key: 'steps', done: false }), 's2');
  assert.equal(relevantStepId(view, { key: 'evidence', done: false }), 's2');
  assert.equal(relevantStepId(view, { key: 'steps', done: true }), '');
  assert.equal(toneKey('active'), 'blue');
  assert.equal(toneKey('danger'), 'danger');
  assert.equal(toneKey('neutral'), 'muted');
});

test('artifactFiles shim keeps web format/summary semantics', () => {
  assert.equal(artifactFormat({ fileName: 'a.md', mimeType: 'text/markdown' }).kind, 'markdown');
  assert.equal(artifactFormat({ fileName: 'x.svg', mimeType: 'image/svg+xml' }).sourceOnly, true);
  assert.equal(artifactFormat({ fileName: 'p.html', mimeType: 'application/octet-stream' }).kind, 'html');
  assert.equal(artifactFormat({ fileName: 'i.webp', mimeType: 'image/webp' }).kind, 'image');
  assert.equal(artifactFormat({ fileName: 'b.zip', mimeType: 'application/zip' }).kind, 'unsupported');
  assert.equal(artifactFormat({ fileName: 'c.py', mimeType: 'text/x-python' }).language, 'python');
  assert.equal(formatFileSize(69616), '68.0 KB');
  assert.equal(artifactSharedPath({ workspacePath: 'workspace/artifacts/a/b.md' }), 'workspace/artifacts/a/b.md');
  assert.equal(artifactSharedPath({ workspacePath: 'workspace/artifacts/../x' }), '');
  const md = '```\n# 不是标题\n```\n# 报告 **标题**\n\n第一段 `代码` 与 [链接](http://x)。\n续行\n\n第二段';
  assert.deepEqual(extractArtifactSummary(md, 'markdown'), { title: '报告 标题', excerpt: '第一段 代码 与 链接。 续行' });
  assert.equal(extractArtifactSummary('a\n\nb\nc\nd', 'text').excerpt, 'a b c');
  assert.equal(artifactPresentation({ fileName: 'r.zip', mimeType: 'application/zip' }).category, 'archive');
  assert.equal(artifactPresentation({ fileName: 'r.html', mimeType: 'text/html' }).action, '页面 / 源码');
});

test('code highlight tokenises comments, strings, keywords and xml tags', () => {
  const py = highlightLine('def f(x): return "s"  # c', 'python');
  assert.ok(py.some((t) => t.kind === 'keyword' && t.text === 'def'));
  assert.ok(py.some((t) => t.kind === 'string' && t.text === '"s"'));
  assert.equal(py.at(-1).kind, 'comment');
  assert.equal(py.map((t) => t.text).join(''), 'def f(x): return "s"  # c');
  const json = highlightLine('  "a": 1,', 'json');
  assert.ok(json.some((t) => t.kind === 'attr'));
  const xml = highlightLine('<div class="x">hi</div>', 'xml');
  assert.ok(xml.some((t) => t.kind === 'tag'));
  assert.equal(xml.map((t) => t.text).join(''), '<div class="x">hi</div>');
  assert.deepEqual(chunkLines('a\nb\nc', 2).map((c) => c.start), [0, 2]);
});

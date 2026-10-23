// B3 输入区与运行配置的纯逻辑单测：引用胶囊受控文本模型（发送编码与 Web codec 一致、原子删除、@ 触发）、
// 运行配置映射与串行保存队列、发送链路（requestId 跟踪、失败恢复、插话事件）、新会话默认配置解析。
// 运行：npm test
import test from 'node:test';
import assert from 'node:assert/strict';

import * as codec from '../../web/src/references/codec.js';
import {
  applyDisplayChange,
  displayText,
  insertRefs,
  mentionAt,
  parseDraftText,
  referenceFromUrl,
  referenceOrder,
  refFromExternal,
  removeRef,
  serialize,
  uniqueRefs,
} from '../src/references/draftModel.ts';
import {
  conversationRequestsForPatch,
  contextUsageView,
  createPayloadFromRunConfig,
  createRunConfigSaveQueue,
  defaultsPatchFromRunConfig,
  groupModels,
  modelTags,
  normalizeStrategy,
  resolveDraftRunConfig,
  runConfigFromState,
  canCompactNow,
} from '../src/runconfig/logic.ts';
import {
  applyPendingSteeringEvent,
  createOutboundSendTracker,
  createRequestId,
  pastedFileName,
  restoreOutboundDraft,
  uploadBadge,
  uploadStatusText,
} from '../src/composer/sendLogic.ts';

const mem = { kind: 'mem', id: '73', label: 'rea-cli' };
const chat = { kind: 'chat', id: '6dd56394-47a7-41bc-92c4-b7cf0f37be00', label: '[b3] 会话', scope: 'recent', turns: 5 };

test('serialize uses exactly the Web reference token (codec.documentToText)', () => {
  const { segments } = insertRefs([{ type: 'text', text: 'see ' }], 4, 4, [codec.normalizeReference(mem)]);
  const web = codec.documentToText({ content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see ' }, { type: 'reference', attrs: codec.normalizeReference(mem) }, { type: 'text', text: ' ' }] }] });
  assert.equal(serialize(segments), web);
  assert.equal(serialize(segments), 'see [rea-cli](openbear://ref/mem/73) ');
});

test('parseDraftText round-trips tokens with scope, mode and escaped labels', () => {
  const refs = [codec.normalizeReference(chat), codec.normalizeReference({ ...mem, label: 'a [b]*c', mode: 'mention' })];
  const text = `x ${codec.referenceToken(refs[0])} y ${codec.referenceToken(refs[1])}\nz`;
  const segs = parseDraftText(text);
  assert.equal(serialize(segs), text);
  assert.equal(segs.filter((s) => s.type === 'ref').length, 2);
  assert.deepEqual(referenceFromUrl(codec.referenceUrl(refs[0]), refs[0].label), refs[0]);
  assert.equal(referenceFromUrl('openbear://ref/mem/1?mode=bogus'), null);
});

test('display edits: deleting into a capsule removes it whole; typing inside moves after it', () => {
  const { segments } = insertRefs([{ type: 'text', text: 'see ' }], 4, 4, [codec.normalizeReference(mem)]);
  const shown = displayText(segments); // "see @rea-cli "
  // 退格删掉胶囊最后一个字符（光标在胶囊后、空格前）
  const del = applyDisplayChange(segments, shown.slice(0, 11) + shown.slice(12));
  assert.equal(displayText(del.segments), 'see  ');
  assert.equal(del.cursor, 4);
  // 在胶囊中间插入字符
  const ins = applyDisplayChange(segments, shown.slice(0, 7) + 'X' + shown.slice(7));
  assert.equal(serialize(ins.segments), 'see [rea-cli](openbear://ref/mem/73)X ');
  // 普通文字编辑不影响胶囊
  const typed = applyDisplayChange(segments, shown + 'ok');
  assert.equal(serialize(typed.segments), 'see [rea-cli](openbear://ref/mem/73) ok');
  assert.equal(typed.cursor, undefined);
  assert.equal(displayText(removeRef(segments, segments[1].uid)), 'see  ');
});

test('@ mention: namespaces, and not inside code or quotes', () => {
  const at = (text) => mentionAt([{ type: 'text', text }], text.length);
  assert.deepEqual({ ...at('see @mem/rea') }, { from: 4, to: 12, query: 'rea', kind: 'mem' });
  assert.equal(at('see @').query, '');
  assert.equal(at('`code @x'), null);
  assert.equal(at('"quoted @x'), null);
  assert.equal(at('```\nfence @x'), null);
  assert.equal(at('mail a@b'), null);
});

test('reference order keeps previous order and appends new keys', () => {
  const a = insertRefs([], 0, 0, [codec.normalizeReference(mem)]).segments;
  const b = insertRefs(a, displayText(a).length, displayText(a).length, [codec.normalizeReference(chat)]).segments;
  const keys = uniqueRefs(b).map(codec.referenceKey);
  assert.deepEqual(referenceOrder([keys[1]], b), [keys[1], keys[0]]);
});

test('external insert (b2: 引用本轮问答) builds a turn reference', () => {
  const ref = refFromExternal({ kind: 'turn', conversationUuid: chat.id, turnUuid: 't-1', title: '本轮' });
  assert.equal(codec.referenceToken(ref), `[本轮](openbear://ref/turn/${chat.id}/t-1)`);
});

test('run config: state mapping, per-field requests and defaults payloads', () => {
  const state = { model: 'OpenAI/x', thinkingLevel: 'high', fastRequested: true, contextStrategy: 'model_summary', agentRunConfig: { model: '', thinkLevel: 'low', fastMode: null } };
  assert.deepEqual(runConfigFromState(state), { model: 'OpenAI/x', thinkLevel: 'high', fastMode: true, agentModel: '', agentThinkLevel: 'low', agentFastMode: null, contextStrategy: 'model_summary' });
  assert.equal(normalizeStrategy('summary'), 'model_summary');
  assert.deepEqual(conversationRequestsForPatch({ agentFastMode: null }), [{ kind: 'conversationSetAgentRunConfig', args: [{ fastMode: null }] }]);
  assert.deepEqual(conversationRequestsForPatch({ contextStrategy: 'sliding' }), [{ kind: 'conversationSetContextStrategy', args: ['sliding_window'] }]);
  assert.deepEqual(defaultsPatchFromRunConfig({ model: 'm', agentThinkLevel: '' }), { mainModel: 'm', agentThinkLevel: '' });
});

test('serial save queue applies responses in click order', async () => {
  const applied = [];
  const queue = createRunConfigSaveQueue({ isCurrent: () => true, apply: (rc) => applied.push(rc.model) });
  const full = (model) => ({ runConfig: { conversationUuid: 'c', model, thinkingLevel: '', effectiveThinkingLevel: '', thinkingLevels: [], defaultThinkingLevel: '', supportsThinking: false, fastMode: false, fastRequested: false, fastSupported: false, effectiveFastMode: false, agentRunConfig: {}, contextWindow: 0, rolloverTriggerTokens: 0, windowTriggerRatio: 0.7 } });
  const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  await Promise.all([queue.enqueue('c', () => delay(30, full('a'))), queue.enqueue('c', () => delay(1, full('b'))), queue.enqueue('c', () => delay(5, full('c')))]);
  assert.deepEqual(applied, ['a', 'b', 'c']);
  await assert.rejects(queue.enqueue('c', async () => ({ ok: true })), /run_config_missing/);
});

test('new conversation defaults resolve against available models', () => {
  const models = [{ key: 'A', thinkingLevels: ['low', 'high'], supportsFast: true, primary: true }, { key: 'B', thinkingLevels: [] }];
  const cfg = resolveDraftRunConfig({ mainModel: 'gone', mainThinkingLevel: 'xhigh', mainFastMode: true, agentModel: 'B', agentFastMode: true, contextStrategy: 'model_summary' }, models);
  assert.deepEqual(cfg, { model: 'A', thinkLevel: 'high', fastMode: true, agentModel: 'B', agentThinkLevel: '', agentFastMode: null, contextStrategy: 'model_summary' });
  assert.equal(createPayloadFromRunConfig(cfg).mainModel, 'A');
  assert.deepEqual(groupModels([{ key: 'x', provider: 'P' }, { key: 'y', provider: 'Q' }], 'q').map((g) => g.provider), ['Q']);
  assert.deepEqual(modelTags({ key: 'k', contextWindow: 200000, reasoning: true }).map((t) => t.label), ['200K 上下文', '140K 压缩', '思考']);
});

test('context usage never shows 0% without a measurement; compact gating', () => {
  const unknown = contextUsageView({ contextUsage: { known: false }, contextWindow: 1000 }, null);
  assert.equal(unknown.percent, null);
  assert.equal(unknown.percentLabel, '—');
  const known = contextUsageView({ contextUsage: { known: true, tokens: 600, rolloverTriggerTokens: 1000 }, contextStrategy: 'model_summary', manualCompactMinPercent: 50 }, { key: 'm', contextWindow: 2000, rolloverTriggerTokens: 1000 });
  assert.equal(known.percentLabel, '60.0%');
  assert.equal(canCompactNow({ contextStrategy: 'model_summary', manualCompactMinPercent: 50 }, known, false).ok, true);
  assert.equal(canCompactNow({ contextStrategy: 'sliding_window' }, known, false).ok, false);
});

test('send chain: one pending send per requestId, recovery merges drafts, steering events', () => {
  let timeoutHit = null;
  const timers = [];
  const tracker = createOutboundSendTracker({ scheduleTimeout: (fn) => (timers.push(fn), timers.length), clearScheduledTimeout: () => {}, onTimeout: (p) => (timeoutHit = p) });
  const id = createRequestId();
  assert.match(id, /^[0-9a-f-]{36}$/);
  const pending = tracker.begin({ requestId: id });
  assert.ok(pending);
  assert.equal(tracker.begin({ requestId: 'other' }), null);
  tracker.markSent(pending);
  assert.equal(tracker.take('nope'), null);
  assert.equal(tracker.take(id), pending);
  assert.equal(timeoutHit, null);
  assert.equal(restoreOutboundDraft('sent', ''), 'sent');
  assert.equal(restoreOutboundDraft('sent', 'typed'), 'sent\n\ntyped');
  const items = applyPendingSteeringEvent([], { action: 'snapshot', items: [{ id: 'a', visibleText: 'hi' }, { id: 'b', text: 'yo' }] });
  assert.equal(items.length, 2);
  assert.deepEqual(applyPendingSteeringEvent(items, { action: 'drain', itemIds: ['a'] }).map((i) => i.id), ['b']);
  assert.equal(uploadBadge({ phase: 'failed', percent: 0 }), '失败 · 已保留');
  assert.equal(uploadBadge({ phase: 'complete', percent: 100 }), '待确认');
  assert.equal(uploadStatusText({ loaded: 50, total: 100, fileIndex: 0, fileCount: 2, phase: 'finalizing' }), '上传附件 1/2 · 50% · 保存中');
  assert.equal(pastedFileName('image/png', 0, 7), 'pasted-image-7-1.png');
});

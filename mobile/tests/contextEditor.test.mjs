// 上下文编辑器状态与操作（src/contexteditor/model.ts，复用 web contextEditor/operations.js + sequence.js）。
import test from 'node:test';
import assert from 'node:assert/strict';

import * as m from '../src/contexteditor/model.ts';

function sample() {
  return {
    format: 'openbear-context-edit/1',
    system: 'You are OpenBear.',
    tools: [{ name: 'Read', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }, { name: 'Bash', description: '执行命令', parameters: { type: 'object', properties: {} } }],
    entries: [
      { entryId: 'u1', message: { role: 'user', content: '看一下 README' } },
      { entryId: 'a1', message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'Read', arguments: '{"path":"README.md"}' }, { id: 'c2', name: 'Bash', arguments: '{"cmd":"ls"}' }] } },
      { entryId: 't1', message: { role: 'tool', name: 'Read', tool_call_id: 'c1', content: '# README' } },
      { entryId: 't2', message: { role: 'tool', name: 'Bash', tool_call_id: 'c2', content: 'a\nb' } },
      { entryId: 'a2', message: { role: 'assistant', content: '读完了', reasoning: '想一想', signature: 'sig' } },
    ],
    origin: { modelLabel: 'OpenAI/gpt-x' },
  };
}

function result(extra = {}) {
  return { ok: true, baseline: sample(), snapshotToken: 'snap-1', draft: null, models: [{ label: 'OpenAI/gpt-x', model: 'OpenAI/gpt-x', protocol: 'responses' }, { label: 'Anthropic/c', model: 'Anthropic/c', protocol: 'anthropic' }], targetModel: 'OpenAI/gpt-x', ...extra };
}

test('载入：无草稿用最新快照；有改动的服务器草稿优先；快照变化时提示加载最新', () => {
  const s = m.resolveLoaded(result(), null);
  assert.equal(s.mode, 'compatible');
  assert.equal(s.targetModel, 'OpenAI/gpt-x');
  assert.equal(s.latestSource, null);
  assert.equal(m.diffDocument(s.baseline, s.working).length, 0);

  const working = sample();
  working.system = 'edited';
  const withDraft = m.resolveLoaded(result({ snapshotToken: 'snap-2', draft: { baseline: sample(), working, snapshotToken: 'snap-1', mode: 'compatible', targetModel: 'OpenAI/gpt-x', revision: 3 } }), null);
  assert.equal(withDraft.working.system, 'edited');
  assert.equal(withDraft.revision, 3);
  assert.ok(withDraft.latestSource, '草稿基于旧快照：提示加载最新');
  const fresh = m.confirmDialog(withDraft, { kind: 'refresh' });
  assert.equal(fresh.working.system, 'You are OpenBear.');
  assert.equal(fresh.latestSource, null);

  // 未改动的旧草稿不应挡住新内容
  const untouched = m.resolveLoaded(result({ snapshotToken: 'snap-2', draft: { baseline: sample(), working: sample(), snapshotToken: 'snap-1', mode: 'compatible', targetModel: 'OpenAI/gpt-x', revision: 1 } }), null);
  assert.equal(untouched.latestSource, null);
  assert.equal(untouched.snapshotToken, 'snap-2');
});

test('改动、撤销、重做、改动计数与保存状态', () => {
  let s = m.resolveLoaded(result(), null);
  s = m.commitText(s, 'system', 'system', 'new system');
  assert.equal(s.epoch, 1);
  assert.equal(m.diffDocument(s.baseline, s.working).length, 1);
  assert.equal(m.commitText(s, 'system', 'system', 'new system'), s, '相同文本不产生改动');
  s = m.commitText(s, 'u1', 'content', '看一下 CHANGELOG');
  assert.equal(m.diffDocument(s.baseline, s.working).length, 2);
  s = m.history(s, 'undo');
  assert.equal(s.working.entries[0].message.content, '看一下 README');
  s = m.history(s, 'redo');
  assert.equal(s.working.entries[0].message.content, '看一下 CHANGELOG');
  assert.notEqual(s.savedEpoch, s.epoch);
});

test('新增消息、上移下移、批量删除影响（联动结果与调用）', () => {
  let s = m.resolveLoaded(result(), null);
  s = m.addEntry(s, 'user', 'a2', 'n1');
  assert.equal(s.working.entries.at(-1).entryId, 'n1');
  s = m.moveEntry(s, 'n1', -1);
  assert.equal(s.working.entries.at(-2).entryId, 'n1');
  assert.equal(m.moveEntry(s, 'u1', -1), s, '第一条不能再上移');

  const impact = m.entriesImpact(s.working, ['a1']);
  assert.deepEqual(impact.sort(), ['a1.message', 't1.message', 't2.message'].sort());
  const resultOnly = m.entriesImpact(s.working, ['t1']);
  assert.ok(resultOnly.includes('a1.tool_calls[c1]'), '删结果会联动删对应调用');
  s = m.confirmDialog(s, { kind: 'entries', ids: ['t1'], impact: resultOnly });
  assert.deepEqual(s.working.entries.find((e) => e.entryId === 'a1').message.tool_calls.map((c) => c.id), ['c2']);
});

test('删除工具调用：删调用和返回 / 只删调用（自动转原始实验）', () => {
  const s0 = m.resolveLoaded(result(), null);
  const dialog = { kind: 'call', id: 'a1', callId: 'c1', impact: m.callImpact(s0.working, 'a1', 'c1') };
  const lines = m.callImpactLines(dialog, 'only');
  assert.deepEqual(lines.orphan, ['t1']);
  assert.ok(!lines.remove.includes('t1.message'));
  const paired = m.confirmDialog(s0, dialog, { deleteMode: 'paired' });
  assert.ok(!paired.working.entries.some((e) => e.entryId === 't1'));
  assert.equal(paired.mode, 'compatible');
  const only = m.confirmDialog(s0, dialog, { deleteMode: 'only' });
  assert.ok(only.working.entries.some((e) => e.entryId === 't1'));
  assert.equal(only.mode, 'raw');
  assert.ok(m.localIssues(only.working).some((i) => i.severity === 'error'), '孤儿结果产生本地错误');
});

test('工具定义：添加、编辑（字段/完整 JSON）、删除、筛选', () => {
  let s = m.resolveLoaded(result(), null);
  let draft = m.openEntity(s.working, 'tools', 'tool', -1);
  draft = { ...draft, data: { ...draft.data, name: 'Grep', description: '搜索' }, text: '{"type":"object","properties":{"q":{"type":"string"}}}' };
  s = m.saveEntity(s, draft);
  assert.equal(s.working.tools.length, 3);
  assert.deepEqual(Object.keys(s.working.tools[2].parameters.properties), ['q']);
  let edit = m.openEntity(s.working, 'tools', 'tool', 0);
  edit = m.entityView(edit, 'raw');
  edit = { ...edit, raw: JSON.stringify({ name: 'Read', description: '读取', parameters: { type: 'object', properties: {} } }) };
  s = m.saveEntity(s, edit);
  assert.equal(s.working.tools[0].description, '读取');
  assert.throws(() => m.saveEntity(s, { ...m.openEntity(s.working, 'tools', 'tool', -1), text: '{' }));
  assert.deepEqual(m.toolRows(s.working, 'grep').map((r) => r.index), [2]);
  s = m.confirmDialog(s, { kind: 'tool', index: 2, impact: [] });
  assert.equal(s.working.tools.length, 2);
});

test('助手内容块：调用编辑、新增调用、附加字段、正文块', () => {
  let s = m.resolveLoaded(result(), null);
  const sequence = m.messageSequence(s.working.entries[1].message);
  assert.equal(sequence.ordered, false);
  assert.deepEqual(sequence.rows.map((r) => r.source), ['content', 'tool_calls', 'tool_calls']);
  assert.equal(m.canMoveBlock(s.working.entries[1].message, 'call-0', 1), true);
  s = m.shiftBlock(s, 'a1', 'call-0', 1);
  assert.deepEqual(s.working.entries[1].message.tool_calls.map((c) => c.id), ['c2', 'c1']);
  const callDraft = m.openBlock(s.working, 'a1', m.messageSequence(s.working.entries[1].message).rows[1]);
  assert.equal(callDraft.kind, 'call');
  s = m.saveEntity(s, { ...callDraft, text: '{"cmd":"pwd"}' });
  assert.equal(s.working.entries[1].message.tool_calls[0].arguments, '{"cmd":"pwd"}');
  const added = m.saveEntity(s, { ...m.openEntity(s.working, 'a2', 'call', -1, '', 'c9'), data: { id: 'c9', name: 'Read', arguments: '{}' }, text: '{}' });
  assert.equal(added.working.entries[4].message.tool_calls[0].id, 'c9');
  assert.deepEqual(m.extraFields(s.working.entries[4].message), ['reasoning', 'signature']);
  const reasoning = m.saveEntity(s, { ...m.openEntity(s.working, 'a2', 'field', -1, 'reasoning'), text: '改过的思考' });
  assert.equal(reasoning.working.entries[4].message.reasoning, '改过的思考');
  const thinking = m.confirmDialog(s, { kind: 'thinking', id: 'a2', impact: m.reasoningImpact(s.working, 'a2') }, { thinkingScope: 'one' });
  assert.equal(thinking.working.entries[4].message.signature, undefined);
  const body = m.revealBody(s, 'a1');
  assert.equal(body.draft.field, 'content');
});

test('原生顺序消息（Responses）：新增正文块写入 native_output_items 并同步 content', () => {
  const base = sample();
  base.entries[4] = { entryId: 'a2', message: { role: 'assistant', content: '读完了', native_output_items: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '读完了' }] }] } };
  let s = m.resolveLoaded(result({ baseline: base }), null);
  assert.equal(m.messageSequence(s.working.entries[4].message).ordered, true);
  const { state, draft } = m.revealBody(s, 'a2');
  assert.equal(state.working.entries[4].message.native_output_items.length, 3);
  assert.equal(draft.blockTextIndex, 0);
  s = m.saveEntity(state, { ...draft, text: '补充一句' });
  assert.equal(s.working.entries[4].message.content, '读完了补充一句');
});

test('完整 JSON 应用、差异单项还原与全部还原', () => {
  let s = m.resolveLoaded(result(), null);
  assert.throws(() => m.applyRaw(s, 'system', '{"system": 1}'), /system 必须是字符串/);
  assert.throws(() => m.applyRaw(s, 'u1', '{bad'));
  s = m.applyRaw(s, 'u1', JSON.stringify({ role: 'user', content: '改了' }));
  s = m.applyRaw(s, 'system', JSON.stringify({ system: 'S2' }));
  let changes = m.diffDocument(s.baseline, s.working);
  assert.deepEqual(changes.map((c) => c.id).sort(), ['system', 'u1']);
  s = m.restore(s, changes.find((c) => c.id === 'u1'));
  changes = m.diffDocument(s.baseline, s.working);
  assert.deepEqual(changes.map((c) => c.id), ['system']);
  s = m.restore(s, null);
  assert.equal(m.diffDocument(s.baseline, s.working).length, 0);
});

test('创建分支的前置条件与失败文案', () => {
  let s = m.resolveLoaded(result(), null);
  assert.match(m.branchBlockReason(s, { busy: true, title: 'x' }), /运行中/);
  assert.match(m.branchBlockReason(s, { busy: false, title: 'x' }), /重新运行服务器预览/);
  s = { ...s, preview: { ok: true, payload: { input: [] }, issues: [] }, previewEpoch: s.epoch };
  assert.match(m.branchBlockReason(s, { busy: false, title: ' ' }), /标题/);
  assert.equal(m.branchBlockReason(s, { busy: false, title: '新分支' }), '');
  const raw = m.setting(s, 'mode', 'raw');
  assert.match(m.branchBlockReason(raw, { busy: false, title: '新分支' }), /原始实验稿/);
  assert.equal(m.previewReady(raw), false, '改设置让预览失效');
  assert.match(m.failure({ status: 409, body: { error: 'draft_conflict' } }), /^冲突（409）.*草稿仍保留/);
  assert.equal(m.failure({ status: 400, body: { error: 'model_not_found' } }), '目标模型不存在（model_not_found）');
});

test('导出 / 导入完整包往返', () => {
  let s = m.resolveLoaded(result(), null);
  s = m.commitText(s, 'system', 'system', 'X');
  const pkg = JSON.parse(JSON.stringify(m.exportPackage(s.baseline, s.working, s.mode, s.targetModel)));
  assert.equal(pkg.format, 'openbear-context-edit-package/1');
  const fresh = m.resolveLoaded(result(), null);
  const imported = m.importIntoState(fresh, pkg);
  assert.equal(imported.working.system, 'X');
  assert.equal(imported.undo.length, 0);
  assert.throws(() => m.importIntoState(fresh, { format: 'nope' }), /完整上下文包/);
});

test('目录：搜索、片段、问题定位', () => {
  const s = m.resolveLoaded(result(), null);
  assert.deepEqual(m.filterEntries(s.working, 'changelog').map((e) => e.entryId), []);
  assert.deepEqual(m.filterEntries(s.working, 'readme').map((e) => e.entryId), ['u1', 'a1', 't1']);
  assert.equal(m.snippet(s.working.entries[1].message), 'Read · Bash');
  assert.equal(m.snippet(s.working.entries[2].message), 'Read · # README');
  assert.equal(m.issueTarget(s.working, { path: 'tools[0].name', severity: 'error', text: '' }), 'tools');
  assert.equal(m.issueTarget(s.working, { entryId: 'a2', severity: 'error', text: '' }), 'a2');
  assert.equal(m.selectionLabel(s.working, 't1'), 'tool · 第 3 条');
});

test('撤销栈有上限', () => {
  let s = m.resolveLoaded(result(), null);
  for (let i = 0; i < m.UNDO_LIMIT + 10; i += 1) s = m.commitText(s, 'system', 'system', `v${i}`);
  assert.equal(s.undo.length, m.UNDO_LIMIT);
  assert.equal(s.epoch, m.UNDO_LIMIT + 10);
});

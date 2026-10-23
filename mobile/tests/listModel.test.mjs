// 会话列表纯逻辑（src/ui/conversations/listModel.ts）：状态归类、分组顺序、筛选计数、相对时间。
import test from 'node:test';
import assert from 'node:assert/strict';

import { countsOf, formatListTime, matchesFilter, phoneSections, previewOf, rowState, sidebarSections } from '../src/ui/conversations/listModel.ts';

const NOW = new Date(2026, 9, 13, 10, 0, 0).getTime(); // 周二 10:00（本地时区）
const sec = (ms) => Math.floor(ms / 1000);
const conv = (id, extra = {}) => ({ conversationUuid: id, title: id, path: '临时会话', lastConversationAt: sec(NOW - 60 * 60 * 1000), ...extra });

const items = [
  conv('wait', { pendingInteractionCount: 1, running: true, activityState: 'waiting', path: 'openbear' }),
  conv('pin', { pinned: true, path: 'parrot' }),
  conv('run', { running: true, status: 'running', activityState: 'running', path: 'parrot' }),
  conv('fail', { activityState: 'failed', activityResult: { status: 'failed' } }),
  conv('yday', { lastConversationAt: sec(NOW - 20 * 60 * 60 * 1000), path: 'openbear' }),
  conv('old', { lastConversationAt: sec(NOW - 9 * 24 * 60 * 60 * 1000) }),
  conv('arch', { archived: true }),
];

test('rowState: waiting 优先于 running；failed 来自 activityState/activityResult', () => {
  assert.equal(rowState(items[0]), 'waiting');
  assert.equal(rowState(items[2]), 'running');
  assert.equal(rowState(items[3]), 'failed');
  assert.equal(rowState(items[5]), 'idle');
});

test('phoneSections: 需要你处理 → 置顶 → 今天 → 昨天 → 更早，归档不显示', () => {
  const sections = phoneSections(items, 'activity', NOW);
  assert.deepEqual(sections.map((s) => s.title), ['需要你处理', '置顶', '今天', '昨天', '更早']);
  assert.deepEqual(sections.map((s) => s.items.map((c) => c.conversationUuid)), [['wait'], ['pin'], ['run', 'fail'], ['yday'], ['old']]);
});

test('sidebarSections: 置顶后按目录分组，临时会话排最后', () => {
  const titles = sidebarSections(items).map((s) => s.title);
  assert.deepEqual(titles.slice(0, 2), ['需要你处理', '置顶']);
  assert.equal(titles.at(-1), '临时会话');
});

test('countsOf / matchesFilter', () => {
  const counts = countsOf(items);
  assert.equal(counts.running, 1);
  assert.equal(counts.waiting, 1);
  assert.deepEqual(counts.folders.map((f) => f.name).sort(), ['openbear', 'parrot']);
  assert.equal(items.filter((c) => matchesFilter(c, { kind: 'folder', name: 'parrot' })).length, 2);
});

test('formatListTime: 刚刚 / HH:MM / 昨天 / 周X / M月D日', () => {
  assert.equal(formatListTime(NOW - 30 * 1000, NOW), '刚刚');
  assert.equal(formatListTime(new Date(2026, 9, 13, 9, 12).getTime(), NOW), '09:12');
  assert.equal(formatListTime(new Date(2026, 9, 12, 22, 0).getTime(), NOW), '昨天');
  assert.equal(formatListTime(new Date(2026, 9, 10, 9, 0).getTime(), NOW), '周六');
  assert.equal(formatListTime(new Date(2026, 9, 1, 9, 0).getTime(), NOW), '10月1日');
});

test('previewOf: 优先 preview，回退 currentStatus，忽略“就绪”', () => {
  assert.equal(previewOf({ conversationUuid: 'a', title: '', preview: '  摘要\n第二行 ' }), '摘要 第二行');
  assert.equal(previewOf({ conversationUuid: 'a', title: '', currentStatus: '运行中 · 6 分钟' }), '运行中 · 6 分钟');
  assert.equal(previewOf({ conversationUuid: 'a', title: '', currentStatus: '就绪' }), '');
});

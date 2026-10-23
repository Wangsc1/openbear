// 会话树纯逻辑（src/tree/treeModel.ts、src/properties/*Model/Queue）：实时状态覆盖、最近视图、目录层级、
// 平板缩进树展开、移动目标禁用、批量能力、菜单可用性、影响合计、运行配置映射与目录默认校验。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVE,
  TEMP,
  blockedTargets,
  branchKey,
  branchParams,
  conversationAbilities,
  crumbsFor,
  draftNeedsReassign,
  emptyBranch,
  flattenTree,
  folderMap,
  indexStatus,
  levelRows,
  liveRow,
  matchFolders,
  mergeRows,
  originOf,
  recentLabel,
  recentSections,
  recentTime,
  rowBadge,
  selectionAbilities,
  sumImpacts,
  waitingCountFor,
} from '../src/tree/treeModel.ts';
import { applyFolderPatch, folderDefaultsToRunConfig, runConfigValue } from '../src/properties/runConfigQueue.ts';
import { conversationRequestsForPatch } from '../src/runconfig/logic.ts';
import { folderRunDefaultsError } from '../src/properties/propertiesModel.ts';

const NOW = new Date(2026, 9, 13, 12, 0, 0).getTime();
const folders = [
  { folderId: 'a', parentId: '', name: '公司', path: '公司' },
  { folderId: 'b', parentId: 'a', name: '客户', path: '公司 / 客户' },
  { folderId: 'c', parentId: 'b', name: '项目A', path: '公司 / 客户 / 项目A' },
  { folderId: 'd', parentId: '', name: 'OpenBear', path: 'OpenBear' },
];
const status = {
  items: [{ conversationUuid: 'run', folderId: 'b', running: true, activityState: 'running', activityPending: [] }],
  activityItems: [
    { conversationUuid: 'run', folderId: 'b', running: true, activityState: 'running', activityPending: [], activityVersion: 1, activityReadVersion: 1 },
    { conversationUuid: 'unread', folderId: 'd', running: false, activityState: 'completed', activityVersion: 3, activityReadVersion: 2, activityUnread: true },
    { conversationUuid: 'wait', folderId: 'c', running: true, activityState: 'waiting', activityPending: [{ interactionId: 'i1', action: 'confirm' }, { interactionId: 'i2', action: 'select' }] },
  ],
  recentItems: [{ conversationUuid: 'old', folderId: '', lastInteractionAtMs: NOW - 3 * 3600000, activityVersion: 0, activityReadVersion: 0 }],
  folderRunningCounts: { a: 1, b: 1 },
  folderConversationCounts: { a: 9, b: 4, '': 3 },
};

test('indexStatus: 未读、运行、待处理计数与目录待处理（含祖先）', () => {
  const index = indexStatus(status, new Map(), folders);
  assert.deepEqual(index.unread.map((r) => r.conversationUuid), ['unread']);
  assert.equal(index.runningCount, 1);
  assert.deepEqual(index.pending.map((r) => r.conversationUuid), ['wait']);
  assert.equal(index.waitingByFolder.get('c'), 1);
  assert.equal(index.waitingByFolder.get('a'), 1);
  assert.equal(index.waitingByFolder.get('d'), undefined);
  // 本地已读回执覆盖未读
  const read = indexStatus(status, new Map([['unread', 3]]), folders);
  assert.equal(read.unread.length, 0);
});

test('liveRow: 会话叠加运行/活动状态；目录叠加运行数与会话数；归档不覆盖', () => {
  const index = indexStatus(status, new Map(), folders);
  const conv = liveRow({ kind: 'conversation', conversationUuid: 'run', title: 'x', running: false }, index);
  assert.equal(conv.running, true);
  assert.equal(conv.status, 'running');
  const idle = liveRow({ kind: 'conversation', conversationUuid: 'zzz', title: 'y', activityUnread: true }, index);
  assert.equal(idle.activityUnread, false);
  const folder = liveRow({ kind: 'folder', folderId: 'a', conversationCount: 1 }, index);
  assert.equal(folder.conversationCount, 9);
  assert.equal(folder.runningDescendantCount, 1);
  const archived = { kind: 'conversation', conversationUuid: 'run', archived: true };
  assert.equal(liveRow(archived, index), archived);
  assert.equal(waitingCountFor({ kind: 'folder', folderId: 'b' }, index), 1);
});

test('recentLabel / recentTime / rowBadge：状态文字与相对时间分开表达', () => {
  assert.equal(recentLabel({ activityPending: [{ action: 'confirm' }] }, NOW), '待确认');
  assert.equal(recentLabel({ running: true }, NOW), '运行中');
  assert.equal(recentLabel({ activityUnread: true, activityState: 'completed' }, NOW), '完成待查看');
  assert.equal(recentLabel({ lastInteractionAtMs: NOW - 30 * 1000 }, NOW), '刚刚');
  assert.equal(recentLabel({ lastInteractionAtMs: NOW - 5 * 60000 }, NOW), '5 分钟前');
  assert.equal(recentTime({ activityUnread: true, activityState: 'failed', lastInteractionAtMs: NOW - 2 * 3600000 }, NOW), '2 小时前');
  assert.deepEqual(rowBadge({ activityPending: [{ action: 'select' }, { action: 'confirm' }] }), { tone: 'wait', label: '待选择 · 2项' });
  assert.deepEqual(rowBadge({ running: true }), { tone: 'run', label: '运行中' });
  assert.deepEqual(rowBadge({}, true), { tone: 'neutral', label: '命名中' });
  assert.deepEqual(rowBadge({ activityUnread: true, activityState: 'failed' }), { tone: 'error', label: '失败待查看' });
  assert.equal(rowBadge({}), null);
});

test('recentSections: 合并会话列表与 recentItems，按最近交互排序并分组，带路径', () => {
  const index = indexStatus(status, new Map(), folders);
  const convs = [
    { conversationUuid: 'today', folderId: 'd', lastConversationAt: Math.floor((NOW - 3600000) / 1000) },
    { conversationUuid: 'yday', folderId: 'a', lastConversationAt: Math.floor((NOW - 20 * 3600000) / 1000) },
    { conversationUuid: 'arch', archived: true },
  ];
  const sections = recentSections(convs, index, folderMap(folders), NOW);
  assert.equal(sections[0].title, '需要你处理');
  assert.equal(sections[0].rows[0].conversationUuid, 'wait');
  const all = sections.flatMap((s) => s.rows.map((r) => r.conversationUuid));
  assert.ok(!all.includes('arch'));
  assert.ok(all.indexOf('today') < all.indexOf('yday'));
  const yday = sections.flatMap((s) => s.rows).find((r) => r.conversationUuid === 'yday');
  assert.equal(yday.path, '公司');
});

test('levelRows: 根级 = 根目录 + 临时会话 + 已归档；子级插入草稿行', () => {
  const index = indexStatus(status, new Map(), folders);
  const root = levelRows('', [{ kind: 'folder', folderId: 'a', name: '公司' }], emptyBranch(), { temporary: 1, archived: 7 }, null, index);
  assert.deepEqual(root.map((r) => r.id || r.folderId), ['a', TEMP, ARCHIVE]);
  assert.equal(root[1].count, 3); // 实时计数优先
  assert.equal(root[2].count, 7);
  const branch = { ...emptyBranch(), loaded: true, items: [{ kind: 'conversation', conversationUuid: 'x', createdAt: 1 }] };
  const withDraft = levelRows('b', [], branch, { temporary: 0, archived: 0 }, { kind: 'conversation', conversationUuid: 'local:new', local: true, createdAt: 9 }, index);
  assert.equal(withDraft.length, 2);
});

test('flattenTree: 只展开 expanded 中的目录，深度递增；空目录、加载失败、加载更多行', () => {
  const index = indexStatus(null, new Map(), folders);
  const branches = {
    [branchKey('a')]: { ...emptyBranch(), loaded: true, items: [{ kind: 'folder', folderId: 'b', parentId: 'a', name: '客户' }, { kind: 'conversation', conversationUuid: 'c1', folderId: 'a' }], hasMore: true },
    [branchKey('b')]: { ...emptyBranch(), loaded: true, items: [] },
    [branchKey(TEMP)]: { ...emptyBranch(), error: 'boom' },
  };
  const rows = flattenTree([{ kind: 'folder', folderId: 'a', name: '公司' }], branches, new Set(['a', 'b', TEMP]), { temporary: 2, archived: 1 }, index, null);
  assert.deepEqual(rows.map((r) => `${r.depth}:${r.inline || r.row.kind}`), ['0:folder', '1:folder', '2:empty', '1:conversation', '1:more', '0:system', '1:error', '0:system']);
  const collapsed = flattenTree([{ kind: 'folder', folderId: 'a', name: '公司' }], branches, new Set(), { temporary: 2, archived: 1 }, index, null);
  assert.equal(collapsed.length, 3);
});

test('branchParams / crumbsFor / matchFolders / mergeRows', () => {
  assert.deepEqual(branchParams(TEMP), { systemNode: 'temporary' });
  assert.deepEqual(branchParams(ARCHIVE), { systemNode: 'archive' });
  assert.deepEqual(branchParams('x'), { parentId: 'x' });
  assert.deepEqual(crumbsFor('c', folderMap(folders)).map((c) => c.name), ['公司', '客户', '项目A']);
  assert.deepEqual(crumbsFor(TEMP, folderMap(folders)).map((c) => c.name), ['临时会话']);
  assert.deepEqual(matchFolders(folders, '客户').map((f) => f.folderId), ['b', 'c']);
  const merged = mergeRows([{ kind: 'conversation', conversationUuid: 'x', title: 'old' }], [{ kind: 'conversation', conversationUuid: 'x', title: 'new' }, { kind: 'folder', folderId: 'f' }]);
  assert.deepEqual(merged.map((r) => r.title || r.folderId), ['f', 'new']);
});

test('blockedTargets: 所选目录自身与全部子孙禁用（多选取并集），会话不禁用任何目录', () => {
  assert.deepEqual([...blockedTargets([{ kind: 'folder', folderId: 'a' }], folders)].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...blockedTargets([{ kind: 'folder', folderId: 'c' }, { kind: 'folder', folderId: 'd' }], folders)].sort(), ['c', 'd']);
  assert.equal(blockedTargets([{ kind: 'conversation', conversationUuid: 'x' }], folders).size, 0);
});

test('conversationAbilities: 与 Web 菜单禁用条件一致', () => {
  const running = conversationAbilities({ conversationUuid: 'x', running: true, lastConversationAt: 1 });
  assert.equal(running.canDelete, false);
  assert.equal(running.canDuplicate, false);
  assert.equal(running.canUpdatePrompt, false);
  assert.equal(running.canGenerateTitle, false);
  const empty = conversationAbilities({ conversationUuid: 'x' });
  assert.equal(empty.canGenerateTitle, false);
  const draft = conversationAbilities({ conversationUuid: 'local:new', local: true });
  assert.equal(draft.canMove, false);
  assert.equal(draft.canRename, false);
  assert.equal(draft.canDelete, true);
  const idle = conversationAbilities({ conversationUuid: 'x', lastConversationAt: 5, activityUnread: true, activityVersion: 2 });
  assert.equal(idle.canGenerateTitle, true);
  assert.equal(idle.canMarkRead, true);
  assert.equal(conversationAbilities({ conversationUuid: 'x' }, true).generateHint, '还没有可用于命名的内容');
});

test('selectionAbilities: 目录只能移动；运行中会话不能删除；全为归档时显示取消归档', () => {
  const mixed = selectionAbilities([{ kind: 'folder', folderId: 'a' }, { kind: 'conversation', conversationUuid: 'x' }]);
  assert.equal(mixed.canMove, true);
  assert.equal(mixed.canArchive, false);
  assert.equal(mixed.canDelete, false);
  const run = selectionAbilities([{ kind: 'conversation', conversationUuid: 'x', running: true }]);
  assert.equal(run.canDelete, false);
  assert.equal(run.runningCount, 1);
  assert.equal(selectionAbilities([{ kind: 'conversation', archived: true }]).allArchived, true);
  assert.equal(selectionAbilities([]).canMove, false);
});

test('sumImpacts / originOf / draftNeedsReassign', () => {
  assert.deepEqual(sumImpacts([{ affectedCount: 1, updatableCount: 1 }, { affectedCount: 2, runningCount: 1, archivedCount: 1 }]), { affectedCount: 3, updatableCount: 1, runningCount: 1, archivedCount: 1 });
  assert.equal(originOf({ origin: 'webhook' }), 'webhook');
  assert.equal(originOf({ origin: 'something' }), 'user');
  assert.equal(draftNeedsReassign(null, 'a'), false);
  assert.equal(draftNeedsReassign({ folderId: 'a' }, 'a'), false);
  assert.equal(draftNeedsReassign({ folderId: '' }, 'a'), true);
});

test('运行配置：会话快照映射、每项对应接口、目录默认的继承/设置与校验', async () => {
  const value = runConfigValue({ model: 'm1', thinkingLevel: 'high', fastRequested: true, agentRunConfig: { model: 'm2', thinkLevel: '', fastMode: null }, contextStrategy: 'model_summary' });
  assert.deepEqual(value, { model: 'm1', thinkLevel: 'high', fastMode: true, agentModel: 'm2', agentThinkLevel: '', agentFastMode: null, contextStrategy: 'model_summary' });
  // 会话属性与输入区共用 runconfig 的请求映射与串行队列
  assert.deepEqual(conversationRequestsForPatch({ thinkLevel: 'low' }), [{ kind: 'conversationSetThinking', args: ['low'] }]);
  assert.deepEqual(conversationRequestsForPatch({ agentFastMode: true }), [{ kind: 'conversationSetAgentRunConfig', args: [{ fastMode: true }] }]);
  assert.deepEqual(conversationRequestsForPatch({ contextStrategy: 'sliding_window' }), [{ kind: 'conversationSetContextStrategy', args: ['sliding_window'] }]);
  assert.deepEqual(conversationRequestsForPatch({ nope: 1 }), []);
  const local = applyFolderPatch({ mainModel: 'm1', mainFastMode: true }, { fastMode: undefined, thinkLevel: 'high' });
  assert.deepEqual(local, { mainModel: 'm1', mainThinkingLevel: 'high' });
  assert.deepEqual(folderDefaultsToRunConfig(local), { model: 'm1', thinkLevel: 'high' });
  const models = [{ key: 'm1', thinkingLevels: ['low', 'high'], supportsFast: false }, { key: 'm2', thinkingLevels: [], supportsFast: true }];
  const layers = { local: {}, inherited: {}, fallback: { mainModel: 'm1' }, resolved: {} };
  assert.equal(folderRunDefaultsError({ mainModel: 'gone' }, layers, models), '主会话模型 gone 已不可用，请更换或恢复继承');
  assert.equal(folderRunDefaultsError({ mainModel: 'm1', mainFastMode: true }, layers, models), '当前主会话模型不支持 Fast');
  assert.equal(folderRunDefaultsError({ mainModel: 'm1', mainThinkingLevel: 'max' }, layers, models), '主会话思考强度不受当前生效模型支持，请重新选择或恢复继承');
  assert.equal(folderRunDefaultsError({ mainModel: 'm1', mainThinkingLevel: 'high' }, layers, models), '');
});

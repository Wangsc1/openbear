// 会话面板（B4）纯逻辑：累计统计（复用 web ledgerUsage/display/contextUsage）、目录路径、运行计时、格式化、标题动画帧。
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyStatsFrame, clockText, emptyStats, folderPathText, statsFromState, statsView } from '../src/panel/stats.ts';
import { artifactKind, formatBytes, formatTimestamp, utf8Bytes } from '../src/panel/format.ts';
import { runStartedAtMs, waitingForAnswer } from '../src/panel/runInfo.ts';
import { nextTitleFrames } from '../src/panel/title.ts';

const STATE = {
  usage: { input_tokens: 929, output_tokens: 3553, cache_read_tokens: 67123, cache_write_tokens: 38450, cost_usd: 0.2757277, ledger_revision: 167657, stat_total_time_ms_sum: 45796 },
  contextUsage: { known: true, tokens: 53359, rolloverTriggerTokens: 700000, percent: 7.62 },
  timelineTotalDurationMs: 42462,
  rolloverTriggerTokens: 700000,
  modelCalls: [{ total_time_ms: 20000 }, { total_time_ms: 15000 }],
};

test('statsFromState + statsView：与 Web 头部口径一致（输入含缓存读写，命中=读缓存/完整输入）', () => {
  const view = statsView(statsFromState(STATE));
  assert.deepEqual(view.parts, { input: 929 + 67123 + 38450, output: 3553, cache: 67123 });
  assert.equal(view.totalTokens, 929 + 67123 + 38450 + 3553);
  assert.equal(view.totalTokensText, '110.1K');
  assert.equal(view.cacheWrite, 38450);
  assert.equal(view.cachePercentText, `${((67123 * 100) / (929 + 67123 + 38450)).toFixed(1)}%`);
  // 时间线累计耗时为正时取它（不与 model_calls 代理值相加），max(时间线, 明细和)
  assert.equal(view.durationMs, 42462);
  assert.equal(view.durationText, '42s');
  assert.equal(view.costText, '$0.28');
  assert.equal(view.contextUsedText, '53.4K');
  assert.equal(view.contextLimitText, '700K');
  assert.equal(view.contextPercentText, '7.6%');
  assert.match(view.tokensDetail, /Tokens（输入 \+ 输出，缓存已包含在输入中）/);
});

test('未加载 / 空账本：花费显示 —，上下文待实测', () => {
  const view = statsView(emptyStats());
  assert.equal(view.totalTokensText, '0');
  assert.equal(view.costText, '—');
  assert.equal(view.durationText, '—');
  assert.equal(view.contextUsedText, '待实测');
  assert.equal(view.contextPercent, null);
});

test('applyStatsFrame：ledgerUsage 按 revision 只前进；stats 帧更新上下文用量与本轮耗时', () => {
  let s = statsFromState(STATE);
  const older = applyStatsFrame(s, { opId: 'x', opType: 'stats', payload: { ledgerUsage: { ledgerRevision: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 } } });
  assert.equal(older.usage.cost_usd, STATE.usage.cost_usd, '旧 revision 不覆盖');
  s = applyStatsFrame(s, {
    opId: 'stats-2', opType: 'stats',
    payload: {
      durationMs: 9000,
      ledgerUsage: { ledgerRevision: 167700, inputTokens: 1000, outputTokens: 4000, cacheReadTokens: 70000, cacheWriteTokens: 40000, costUsd: 0.5 },
      contextUsage: { available: true, known: true, tokens: 60000, windowVersion: 1, requestSequence: 5 },
    },
  });
  assert.equal(s.usage.ledger_revision, 167700);
  assert.equal(s.usage.cost_usd, 0.5);
  assert.equal(s.contextUsage.tokens, 60000);
  assert.equal(statsView(s).durationMs, 42462 + 9000, '历史累计 + 新一轮');
  assert.equal(statsView(s).costText, '$0.50');
  // 窗口轮转完成：上下文用量失效
  const rotated = applyStatsFrame(s, { opId: 'cw', opType: 'context_window', lifecycle: 'terminal', status: 'completed', payload: { windowVersion: 2 } });
  assert.equal(rotated.contextUsage.known, false);
  assert.equal(statsView(rotated).contextUsedText, '待实测');
  // 无关帧不产生新对象
  assert.equal(applyStatsFrame(s, { opId: 'a', opType: 'assistant', payload: {} }), s);
});

test('folderPathText / clockText', () => {
  assert.equal(folderPathText('openbear / 手机端'), '/openbear/手机端');
  assert.equal(folderPathText(''), '临时会话');
  assert.equal(folderPathText('临时会话'), '临时会话');
  assert.equal(clockText(65_000), '1:05');
  assert.equal(clockText(3_725_000), '1:02:05');
});

test('runStartedAtMs / waitingForAnswer：从尾部找当前轮', () => {
  const rows = [
    { type: 'user', createdAtMs: 1000 },
    { type: 'answer' },
    { type: 'user', createdAtMs: 5000 },
    { type: 'interaction', status: 'pending' },
  ];
  assert.equal(runStartedAtMs(rows, 42), 5000);
  assert.equal(runStartedAtMs([], 42), 42);
  assert.equal(waitingForAnswer(rows), true);
  assert.equal(waitingForAnswer(rows.slice(0, 3)), false);
});

test('format：字节、时间、产物类型、UTF-8 字节数', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KiB');
  assert.equal(formatBytes(20 * 1024), '20 KiB');
  const now = new Date(2026, 9, 13, 12, 0, 0);
  assert.equal(formatTimestamp(Math.floor(new Date(2026, 9, 13, 9, 5).getTime() / 1000), now), '10-13 09:05');
  assert.equal(formatTimestamp(Math.floor(new Date(2025, 0, 2, 3, 4).getTime() / 1000), now), '2025-01-02 03:04');
  assert.equal(formatTimestamp(0), '—');
  assert.equal(artifactKind('a.png', 'image/png'), 'image');
  assert.equal(artifactKind('a.zip', 'application/zip'), 'archive');
  assert.equal(artifactKind('a.py', 'text/x-python'), 'code');
  assert.equal(artifactKind('a.md', 'text/markdown'), 'text');
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('中文'), 6);
  assert.equal(utf8Bytes('😀'), 4);
  assert.equal(utf8Bytes('é'), 2);
});

test('标题逐字帧：字素不拆开', () => {
  assert.deepEqual(nextTitleFrames('ab'), ['a', 'ab']);
  const frames = nextTitleFrames('改名👨‍👩‍👧');
  assert.equal(frames.length, 3);
  assert.equal(frames.at(-1), '改名👨‍👩‍👧');
});

// sheet 工作包的纯逻辑测试：工具类别映射、详情面板的结果解析、ConversationStore.stop() 的 WS 命令。
// 运行：node --import ./tests/support/register.mjs --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TOOL_KIND_LABELS, toolKindKey } from '../src/chat/toolKindRules.ts';
import {
  formatDuration,
  isFailureLine,
  parseFileResult,
  parseKeyValueLines,
  parseSearchResult,
  parseTerminalResult,
  toolOutcome,
} from '../src/chat/detailParse.ts';
import { ConversationStore } from '../src/data/conversationStore.ts';

const DATA = process.env.OPENBEAR_MOBILE_DATA || path.join(os.homedir(), '.cache', 'openbear-mobile');
const BENCH = process.env.OPENBEAR_BENCH_DIR || path.join(DATA, 'bench');

test('toolKind maps tool names to the shared categories', () => {
  const cases = {
    Read: '读取', Grep: '读取', Glob: '读取',
    Bash: '终端',
    web_search: '搜索', web_fetch: '搜索', mcp__parrot__web_search: '搜索', mcp__parrot__web_fetch: '搜索', WebSearch: '搜索',
    Edit: '编辑', Write: '编辑', EditBatch: '编辑',
    Agent: '助手',
    TaskMemory: '工具', History: '工具', '': '工具',
  };
  for (const [name, label] of Object.entries(cases)) assert.equal(TOOL_KIND_LABELS[toolKindKey(name)], label, name);
  assert.equal(toolKindKey('Bash'), 'terminal');
});

test('parseTerminalResult splits backend header from output and reads exit code', () => {
  const raw = 'status: failed\nexit_code: 127\noutput_path: /tmp/x.log\noutput_bytes: 30\ntruncated: false\nnote: exit code 127\noutput:\n/bin/sh: 1: python: not found';
  const r = parseTerminalResult(raw);
  assert.equal(r.exitCode, 127);
  assert.equal(r.output, '/bin/sh: 1: python: not found');
  assert.equal(r.meta.find((m) => m.key === 'note').value, 'exit code 127');
  assert.deepEqual(toolOutcome('completed', raw, r.exitCode), { tone: 'error', label: '退出码 127' });
  const ok = parseTerminalResult('status: ok\nexit_code: 0\noutput:\nhello\n');
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.output, 'hello');
  assert.deepEqual(toolOutcome('completed', 'status: ok', 0), { tone: 'ok', label: '完成' });
  assert.equal(toolOutcome('running', '', null).label, '运行中');
  assert.equal(toolOutcome('cancelled', '', null).label, '已停止');
  // 非后端格式：整体作为输出
  assert.equal(parseTerminalResult('plain text\nline2').output, 'plain text\nline2');
});

test('isFailureLine flags typical failure lines only', () => {
  assert.ok(isFailureLine('sqlite3.OperationalError: no such column'));
  assert.ok(isFailureLine('[acceptance] seed_upgrade ......... FAIL'));
  assert.ok(isFailureLine('Traceback (most recent call last):'));
  assert.ok(!isFailureLine('[acceptance] 14 passed'));
  assert.ok(!isFailureLine('total 692'));
});

test('parseFileResult extracts path and numbered lines from Read results', () => {
  const raw = '<file path="/opt/a.py" size_bytes="10" total_lines="587" offset="430" limit="2" returned_lines="2" truncated="false">\n   431\tdef a():\n   432\t    return 1\n</file>';
  const f = parseFileResult(raw);
  assert.equal(f.path, '/opt/a.py');
  assert.deepEqual(f.lines, [{ no: '431', text: 'def a():' }, { no: '432', text: '    return 1' }]);
  assert.equal(f.note, '共 587 行');
  assert.equal(parseFileResult('just some text\nwithout numbers'), null);
});

test('parseSearchResult reads WebSearch markdown and MCP JSON', () => {
  const md = '## Search Results (2 results, 1916ms)\n\n### 1. 标题一\n- **URL**: https://a.example/x\n- 摘要一\n\n### 2. 标题二\n- **URL**: https://b.example/y\n- 摘要二 date: Sep 26, 2014\n';
  const hits = parseSearchResult(md);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].title, '标题一');
  assert.equal(hits[1].url, 'https://b.example/y');
  const json = JSON.stringify({ status: 'artifact_saved', preview: 'structuredContent:\n' + JSON.stringify({ query: 'q', results: [{ title: 'T', url: 'https://c.example', snippet: 'S' }] }) });
  assert.deepEqual(parseSearchResult(json), [{ title: 'T', url: 'https://c.example', snippet: 'S' }]);
  // 截断的预览（非法 JSON）也能提取
  const truncated = JSON.stringify({ status: 'artifact_saved', preview: 'structuredContent:\n{\n  "results": [\n    {\n      "title": "A",\n      "url": "https://a.example",\n      "snippet": "line1\nline2 …' });
  assert.deepEqual(parseSearchResult(truncated).map((h) => h.url), ['https://a.example']);
});

test('parseKeyValueLines and formatDuration', () => {
  const kv = parseKeyValueLines('status: success\noperation: edit\npath: /opt/x');
  assert.equal(kv.length, 3);
  assert.equal(kv[2].value, '/opt/x');
  assert.equal(parseKeyValueLines('一段普通文字\n第二行'), null);
  assert.equal(formatDuration(22400), '22.4 秒');
  assert.equal(formatDuration(850), '850 毫秒');
  assert.equal(formatDuration(252000), '4 分 12 秒');
  assert.equal(formatDuration(0), '');
});

test('ConversationStore.stop() sends the WS stop command (same protocol as Web)', async () => {
  const sent = [];
  let handlers;
  const api = {
    async state() { return { conversation: { title: 't' }, operations: [], frameSeq: 1, hasMoreBefore: false }; },
    async operations() { return { operations: [] }; },
    async frames() { return { frames: [] }; },
    async operationDetail() { return {}; },
  };
  const factory = (_uuid, _after, h) => {
    handlers = h;
    return { send(payload) { sent.push(payload); return true; }, close() {} };
  };
  const store = new ConversationStore('u1', api, factory, { setTimer: () => 1, clearTimer: () => {} });
  assert.equal(store.stop(), false, 'no socket yet');
  await store.open();
  handlers.onOpen();
  assert.equal(store.stop(), true);
  assert.deepEqual(sent.at(-1), { type: 'stop' });
  store.dispose();
});

test('real bench Bash results parse into output + exit code', { skip: !fs.existsSync(path.join(BENCH, 'manifest.json')) }, () => {
  const file = path.join(BENCH, 'conv', 'a6a877ad-298a-4270-a444-ce4c2b5c292b', 'details.jsonl');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const lines = buf.subarray(0, n).toString('utf8').split('\n').slice(0, -1);
  let checked = 0;
  for (const line of lines) {
    const op = JSON.parse(line);
    if (op.payload?.name !== 'Bash' || typeof op.payload.result !== 'string') continue;
    const r = parseTerminalResult(op.payload.result);
    if (/^exit_code: (\d+)$/m.test(op.payload.result)) {
      assert.equal(r.exitCode, Number(/^exit_code: (\d+)$/m.exec(op.payload.result)[1]));
      assert.ok(!r.output.startsWith('status:'), 'header stripped');
      checked += 1;
    }
  }
  assert.ok(checked > 5, `checked ${checked} Bash results`);
});

// 数据层单元测试：用真实基准数据（<数据目录>/bench，见 scripts/bench/export_bench.py）验证复用的 web 纯逻辑、分页合并、帧回放、行展平和 Markdown 切块。
// 运行：node --import ./tests/support/register.mjs --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConversationStore } from '../src/data/conversationStore.ts';
import { splitTopLevelBlocks, splitMarkdownForRows } from '../src/chat/markdown/splitBlocks.ts';
import { plainText, answerContent, decodeHtml } from '../src/web-shims/markdown.js';

const DATA = process.env.OPENBEAR_MOBILE_DATA || path.join(os.homedir(), '.cache', 'openbear-mobile');
const BENCH = process.env.OPENBEAR_BENCH_DIR || path.join(DATA, 'bench');
const hasBench = fs.existsSync(path.join(BENCH, 'manifest.json'));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function benchApi(uuid) {
  const dir = path.join(BENCH, 'conv', uuid);
  const chain = readJson(path.join(dir, 'pages-200.json'));
  const base = readJson(path.join(dir, 'state-base.json'));
  return {
    chain,
    api: {
      async state() {
        const first = chain[0];
        return { ...base, operations: first.operations, hasMoreBefore: first.hasMoreBefore, nextBeforeDisplaySeq: first.nextBeforeDisplaySeq };
      },
      async operations(_uuid, { beforeDisplaySeq }) {
        const page = chain.find((p) => p.beforeDisplaySeq === beforeDisplaySeq);
        assert.ok(page, `page for before=${beforeDisplaySeq}`);
        return page;
      },
      async frames() { return { frames: [] }; },
      async operationDetail() { return {}; },
    },
  };
}

const syncTimers = { setTimer: (fn) => { fn(); return 1; }, clearTimer: () => {} };

test('web shim plainText/answerContent matches Web semantics', () => {
  assert.equal(plainText('<b>粗体</b> 和 <code>x&lt;1</code>'), '**粗体** 和 `x<1`');
  assert.equal(answerContent('…'), '');
  assert.equal(answerContent('  ...  '), '');
  assert.equal(answerContent('正文'), '正文');
  assert.equal(decodeHtml('&amp;&#39;&#x4e2d;&unknown;'), "&'中&unknown;");
});

test('markdown splitter is lossless and never cuts fences', () => {
  const md = [
    '# 标题', '', '段落一 **强调**。', '', '```python', 'a = 1', '', 'b = 2', '```', '',
    '| a | b |', '|---|---|', '| 1 | 2 |', '', '- 列表1', '  续行', '- 列表2', '', '$$', 'x^2', '$$', '', '> 引用', '懒续行', '',
    '```js', 'unterminated(',
  ].join('\n');
  const blocks = splitTopLevelBlocks(md);
  assert.equal(blocks.map((b) => b.text).join(''), md);
  const code = blocks.filter((b) => b.kind === 'code');
  assert.equal(code.length, 2);
  assert.ok(code[0].text.includes('a = 1\n\nb = 2'));
  assert.ok(blocks.some((b) => b.kind === 'table'));
  assert.ok(blocks.some((b) => b.kind === 'math' && b.text.includes('x^2')));
  const rows = splitMarkdownForRows(md.repeat(20), { minSplitChars: 100, targetChars: 300 });
  assert.equal(rows.map((b) => b.text).join(''), md.repeat(20));
  assert.ok(rows.length > 20);
});

test('long real answers split losslessly', { skip: !hasBench }, () => {
  const corpus = readJson(path.join(BENCH, 'markdown-corpus.json'));
  for (const items of Object.values(corpus)) {
    for (const item of items) {
      const rows = splitMarkdownForRows(item.text, { minSplitChars: 200, targetChars: 400 });
      assert.equal(rows.map((r) => r.text).join(''), item.text);
      for (const row of rows) {
        const fences = (row.text.match(/^ {0,3}```/gm) || []).length;
        assert.equal(fences % 2, 0, `fence split in ${item.opId}`);
      }
    }
  }
});

for (const uuid of ['a6a877ad-298a-4270-a444-ce4c2b5c292b', 'fed2ce26-0699-4ba0-a989-6c512fc1b16b', 'd8e18cc9-d50b-48b3-b44a-0e8b107de4ca']) {
  test(`open + page through ${uuid.slice(0, 8)} with reused web projection`, { skip: !hasBench }, async () => {
    const { api, chain } = benchApi(uuid);
    const store = new ConversationStore(uuid, api, null, syncTimers);
    await store.open();
    const first = store.snapshot;
    assert.equal(first.error, '');
    assert.ok(first.rows.length > 0);
    assert.equal(first.operationCount, chain[0].operations.length);
    // 首屏最后一行应是用户可见的内容（回复/工作摘要/用户），不是 undefined
    assert.ok(first.rows.every((row) => row.key && row.type));
    const keys = new Set(first.rows.map((r) => r.key));
    assert.equal(keys.size, first.rows.length, 'row keys must be unique');
    let pages = 1;
    let previousLastKey = first.rows.at(-1).key;
    while (store.snapshot.hasMoreBefore) {
      const added = await store.loadEarlier();
      pages += 1;
      assert.ok(added >= 0);
      // 向上翻页不改变尾部行（可见位置的锚点）
      assert.equal(store.snapshot.rows.at(-1).key, previousLastKey);
      previousLastKey = store.snapshot.rows.at(-1).key;
    }
    assert.equal(pages, chain.length);
    const all = store.snapshot;
    const allKeys = new Set(all.rows.map((r) => r.key));
    assert.equal(allKeys.size, all.rows.length, 'row keys unique after full paging');
    const total = readJson(path.join(BENCH, 'conv', uuid, 'operations.json')).length;
    assert.equal(all.operationCount, total, 'merged page chain equals full snapshot');
    console.log(`${uuid.slice(0, 8)} ops=${total} turns=${all.turnCount} rows=${all.rows.length} pages=${pages} lastProjectionMs=${all.lastProjectionMs}`);
    store.dispose();
  });
}

test('stream replay frames project into a live answer and finish', { skip: !hasBench }, async () => {
  const uuid = 'd8e18cc9-d50b-48b3-b44a-0e8b107de4ca';
  const { api } = benchApi(uuid);
  const sample = readJson(path.join(BENCH, 'stream', 'deploy-path-analysis.json'));
  const store = new ConversationStore(uuid, api, null, { ...syncTimers, setTimer: () => 1 });
  await store.open();
  const baseRows = store.snapshot.rows.length;
  let seq = store.snapshot.lastFrameSeq;
  const maxDisplay = Math.max(...store.snapshot.rows.length ? [1] : [0]);
  let sawLive = false;
  let projections = 0;
  for (const [index, source] of sample.frames.entries()) {
    store.enqueueFrame({ ...source, conversationUuid: uuid, frameSeq: ++seq, displaySeq: source.displaySeq + 10_000_000 });
    if (index % 10 === 9) {
      store.flushFrames();
      projections += 1;
      if (store.snapshot.rows.some((row) => row.type === 'answer' && row.live)) sawLive = true;
    }
  }
  store.flushFrames();
  assert.ok(maxDisplay >= 0);
  assert.ok(sawLive, 'a live answer row appears mid-stream');
  const last = store.snapshot;
  assert.ok(last.rows.length > baseRows);
  assert.equal(last.running, false);
  assert.ok(last.rows.some((row) => row.type === 'answer' && row.markdown.includes('测试镜像')));
  console.log(`stream: frames=${sample.frames.length} projections=${projections} lastProjectionMs=${last.lastProjectionMs}`);
});

test('a root resumed after a later turn runs as its own continuation block at the bottom', async () => {
  const op = (opId, opType, runId, root, displaySeq, payload = {}, extra = {}) => ({
    opId, opType, runId, targetType: 'run', targetId: runId, runRootTurnId: root, turnUuid: root, revision: 1, displaySeq,
    status: 'completed', lifecycle: 'terminal', createdAtMs: displaySeq * 1000, updatedAtMs: displaySeq * 1000, payload, ...extra,
  });
  const api = {
    async state() {
      return { frameSeq: 1, operations: [
        op('run:root-1', 'run', 'root-1', 'root-1', 10, { runId: 'root-1', status: 'failed' }),
        op('msg:root-1', 'user_message', 'root-1', 'root-1', 11, { text: '审计这套 Java' }),
        op('assistant-error:root-1', 'assistant_message', 'root-1', 'root-1', 12, { text: '本轮执行失败', error: true, complete: true }, { status: 'failed' }),
        op('run:root-2', 'run', 'root-2', 'root-2', 20, { runId: 'root-2' }),
        op('msg:root-2', 'user_message', 'root-2', 'root-2', 21, { text: '算违规吗' }),
        op('assistant:root-2', 'assistant_message', 'root-2', 'root-2', 22, { text: '不算', complete: true }),
        op('run:exec-2', 'run', 'exec-2', 'root-1', 30, { runId: 'exec-2', source: 'task_notification', internal: true, status: 'running' }, { status: 'running', lifecycle: 'active', internal: true }),
        op('tool:exec-2', 'tool', 'exec-2', 'root-1', 31, { name: 'Bash', status: 'completed' }),
        op('assistant:root-1:exec-2', 'assistant_message', 'exec-2', 'root-1', 32, { text: '审计结论', complete: true }),
      ] };
    },
    async operations() { return { operations: [] }; },
    async frames() { return { frames: [] }; },
    async operationDetail() { return {}; },
  };
  const store = new ConversationStore('continuation', api, null, syncTimers);
  await store.open();
  const rows = store.snapshot.rows;
  const header = rows.findIndex((row) => row.type === 'user' && row.continuation);
  assert.ok(header > rows.findIndex((row) => row.type === 'user' && row.text === '算违规吗'), 'the continuation follows the later turn');
  assert.equal(rows[header].continuation.rootUserOpId, 'msg:root-1');
  const summaries = rows.filter((row) => row.type === 'work_summary');
  assert.ok(summaries.every((row) => row.turnKey !== rows[header].turnKey), 'the running continuation keeps its work open');
  store.dispose();
});

test('live progress messages extend the operation in order with frames and request a snapshot on a gap', async () => {
  const uuid = 'live-progress';
  const opId = 'assistant:turn-1:0';
  const sent = [];
  let handlers = null;
  const api = {
    async state() {
      return {
        frameSeq: 5,
        operations: [
          { opId: 'msg:u1', opType: 'user_message', turnUuid: 'turn-1', revision: 1, displaySeq: 10, status: 'completed', lifecycle: 'terminal', payload: { role: 'user', text: '写点东西' } },
          { opId, opType: 'assistant_message', turnUuid: 'turn-1', revision: 1, displaySeq: 20, status: 'running', lifecycle: 'active', payload: { text: 'A', complete: false } },
        ],
      };
    },
    async operations() { return { operations: [] }; },
    async frames() { return { frames: [] }; },
    async operationDetail() { return {}; },
  };
  const socketFactory = (_uuid, _after, h) => { handlers = h; return { send: (payload) => { sent.push(payload); return true; }, close() {} }; };
  const store = new ConversationStore(uuid, api, socketFactory, { ...syncTimers, setTimer: () => 1 });
  await store.open();
  const live = (liveRev, payload, extra = {}) => ({ opId, opType: 'assistant_message', action: 'append', revision: 1, liveRev, payload, ...extra });
  const raw = [];
  store.onRaw((event) => raw.push(event));
  handlers.onMessage({ type: 'live', ops: [live(1, { delta: 'B' }), live(2, { delta: 'C' })] });
  store.flushFrames();
  assert.equal(store.answerText(opId), 'ABC');
  // Panels (session stats) observe applied live updates like frames.
  assert.equal(raw.length, 2);
  assert.equal(raw[1].operation.liveRev, 2);
  handlers.onMessage({ type: 'live', ops: [live(2, { delta: 'C' }), live(5, { delta: 'X' })] });
  store.flushFrames();
  assert.equal(store.answerText(opId), 'ABC', 'repeated and gapped updates are not applied');
  assert.deepEqual(sent, [{ type: 'live_resync' }]);
  // Every live_snapshot entry replaces the payload, whatever action it was serialized with.
  handlers.onMessage({ type: 'live_snapshot', ops: [live(5, { text: 'ABCDE', complete: false }, { action: 'start' })] });
  handlers.onMessage({ type: 'frame', frame: { opId, opType: 'assistant_message', action: 'end', revision: 2, frameSeq: 6, displaySeq: 20, payload: { text: 'ABCDEF', complete: true } } });
  store.flushFrames();
  assert.equal(store.answerText(opId), 'ABCDEF');
  assert.equal(store.operation(opId).liveRev, 0);
  store.dispose();
});

#!/usr/bin/env node
// OpenBear 本地模拟后端（仅开发/基准用）。
//
// 数据来自 scripts/bench/export_bench.py 以只读方式从生产库导出的基准集（默认 <数据目录>/bench）。
// 提供与真实后端相同路径与响应结构的接口：
//   GET  /api/auth/mode, /api/auth/session         —— 模拟会话（Set-Cookie: openbear_web_session），不触发任何 Telegram 流程
//   GET  /api/conversations                        —— 会话列表（基准集中的对话 + 回放对话）
//   GET  /api/conversations/{uuid}/state?timelineLimit=N[&beforeDisplaySeq=S]
//   GET  /api/conversations/{uuid}/operations?timelineLimit=N&beforeDisplaySeq=S
//   GET  /api/conversations/{uuid}/operations/{opId}/detail
//   GET  /api/conversations/{uuid}/frames?afterFrameSeq=X&limit=N
//   WS   /api/conversations/{uuid}/ws?afterFrameSeq=X&bootstrap=incremental
//        收到 {"type":"send"} 时按原始节奏回放一段真实流式帧（stream/*.json），帧被重写到本对话、续接 frameSeq/displaySeq。
//   WS   /api/events/ws                            —— 全局事件（snapshot + 回放期间的 running 状态 patch）
//
// 分页：直接回放后端 _web_operations_page 导出的页链（pages-<limit>.json），
// 所以首屏/翻页结果与后端逐字一致；回放产生的新操作追加在尾部。
//
// 用法：node scripts/mock-server/server.mjs [--port 18787] [--bench DIR] [--speed 1]
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith('--') ? [...acc, [cur.slice(2), all[i + 1]]] : acc), []),
);
const PORT = Number(args.port || process.env.MOCK_PORT || 18787);
const DATA = process.env.OPENBEAR_MOBILE_DATA || path.join(os.homedir(), '.cache', 'openbear-mobile');
const BENCH = args.bench || process.env.OPENBEAR_BENCH_DIR || path.join(DATA, 'bench');
const SPEED = Number(args.speed || process.env.MOCK_REPLAY_SPEED || 1) || 1;
const LATENCY_MS = Number(args.latency || process.env.MOCK_LATENCY_MS || 0) || 0;
const COOKIE = 'openbear_web_session';
// 固定的开发令牌：模拟后端重启后已登录的模拟器无需重新登录（仅本地开发用）
const SESSION_TOKEN = process.env.MOCK_SESSION_TOKEN || 'openbear-mock-dev-session';

const log = (...items) => console.log(new Date().toISOString(), ...items);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const manifest = readJson(path.join(BENCH, 'manifest.json'));
const streams = manifest.streams.map((s) => readJson(path.join(BENCH, 'stream', `${s.name}.json`)));

/** conversationUuid -> lazily loaded bench data */
const conversations = new Map();
for (const info of manifest.conversations) conversations.set(info.conversationUuid, { info, loaded: null });

// ---- 会话列表演示数据（nav 工作包）----
// 真实后端会话项字段见 app/web_console/conversation_tree.py::_tree_conversation_json 与 activity.py；
// 运行统计字段见 conversations.py。时间按“现在”相对计算，保证今天/昨天/更早分组稳定。
// preview 是演示用摘要字段（真实后端暂无）。
const FOLDERS = {
  openbear: { id: 'f0000000-0000-4000-8000-00000000000b', path: 'openbear' },
  parrot: { id: 'f0000000-0000-4000-8000-00000000000a', path: 'parrot' },
  client: { id: 'f0000000-0000-4000-8000-00000000000d', path: '客户项目' },
  ops: { id: 'f0000000-0000-4000-8000-00000000000c', path: '运维' },
  none: { id: '', path: '临时会话' },
};
const MIN = 60;
const HOUR = 3600;
const DAY = 86400;
/** 相对时间：today(h, m) 落在今天（不晚于现在），ago(sec) 为若干秒前。 */
function todayAt(hour, minute) {
  const now = new Date();
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0).getTime() / 1000;
  const nowSec = Date.now() / 1000;
  // 现在还没到该时刻时，退回到“现在之前若干分钟”，仍在今天
  return Math.floor(at <= nowSec ? at : Math.max(nowSec - 25 * MIN, new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000 + 60));
}
const ago = (sec) => Math.floor(Date.now() / 1000 - sec);

/** 3 个真实对话的列表属性（archived 改为 false，补目录、时间、摘要）。 */
const REAL_LIST_OVERRIDES = {
  'a6a877ad-298a-4270-a444-ce4c2b5c292b': () => ({ folder: FOLDERS.client, pinned: true, pinnedAt: ago(30 * DAY), lastConversationAt: todayAt(8, 47), preview: '1022 分钟仍然没让 038 通过，已经足以判定当前路线不可行，建议先回到单步验证，把握手阶段拆开逐项确认…' }),
  'fed2ce26-0699-4ba0-a989-6c512fc1b16b': () => ({ folder: FOLDERS.openbear, lastConversationAt: ago(DAY + 2 * HOUR), preview: 'v0.9.0 的发布说明已整理完毕，升级验收 18/18 通过；剩余两个低优先级问题记入下个版本。' }),
  'd8e18cc9-d50b-48b3-b44a-0e8b107de4ca': () => ({ folder: FOLDERS.parrot, lastConversationAt: todayAt(9, 30), activityUnread: true, preview: 'Parrot v0.31.6 已正式发布：PR #24 已合并，tag 与 GitHub Release 均已就绪。' }),
};

/** 只有列表项、没有内容的虚拟会话（点进去显示“该会话为演示数据”）。 */
const DEMO_LIST = [
  { key: 'wait-native', title: '评估原生客户端方案', folder: FOLDERS.openbear, at: () => ago(20), running: true, waiting: true, preview: '启动 P0：真实聊天核心样板？Android 端和样板工程不依赖 Mac，iOS 构建需要老大的开发机…' },
  { key: 'wait-deploy', title: '生产库迁移确认', folder: FOLDERS.ops, at: () => ago(42 * MIN), running: true, waiting: true, preview: '迁移脚本已在影子库跑通，正式执行前需要你确认维护窗口：今晚 23:00 还是明早 06:00？' },
  { key: 'run-parrot', title: 'Parrot 0.33 发布准备', folder: FOLDERS.parrot, at: () => todayAt(9, 12), running: true, startedAgo: 6 * MIN, unread: true, pinned: true, preview: '正在跑候选包的升级验收，已通过 14/18 项；seed_upgrade 失败，正在确认迁移顺序…' },
  { key: 'run-sync', title: '数据看板夜间同步', folder: FOLDERS.ops, at: () => ago(3 * MIN), running: true, startedAgo: 38 * MIN, preview: '第 3/5 个数据源同步中：订单明细 1.2M 行，预计还需 9 分钟。' },
  { key: 'fail-backup', title: '备份脚本迁移到新机房', folder: FOLDERS.ops, at: () => todayAt(7, 5), failed: true, unread: true, preview: 'rsync 在第 2 步失败：目标卷只读（Read-only file system），已停止后续步骤。' },
  { key: 'today-spec', title: '手机端交互规范', folder: FOLDERS.openbear, at: () => todayAt(8, 20), preview: '底部面板下拉关闭要跟手，不抢正文滚动；键盘弹起时输入框和最后一条消息一起上移。' },
  { key: 'today-pin', title: 'OpenBear 周报模板', folder: FOLDERS.openbear, at: () => todayAt(6, 30), pinned: true, preview: '本周重点：原生客户端 P0 验收通过，界面改版三路并行；下周进入 iOS 联调。' },
  { key: 'y-payment', title: '支付回调超时排查', folder: FOLDERS.ops, at: () => ago(DAY + 5 * HOUR), preview: 'fastcgi 9001 的问题已定位，是 php-fpm 池配置覆盖了 request_terminate_timeout…' },
  { key: 'y-release', title: '发布流程 v3', folder: FOLDERS.openbear, at: () => ago(DAY + 9 * HOUR), unread: true, preview: 'release.py 的 resume 复用仍有效的验证结果，只重跑失败之后的步骤。' },
  { key: 'e-temp', title: '帮我起个周末徒步路线', folder: FOLDERS.none, at: () => ago(3 * DAY), preview: '推荐两条：一条 12km 沿溪谷环线，爬升 450m；另一条 8km 适合带孩子。' },
  { key: 'e-ks', title: '客户接口联调记录', folder: FOLDERS.client, at: () => ago(5 * DAY), preview: '038 号用例在握手阶段超时，抓包显示服务端未回 SYN-ACK，转交网络组排查。' },
  { key: 'e-parrot', title: 'Parrot 渠道优先级设计', folder: FOLDERS.parrot, at: () => ago(9 * DAY), preview: 'channels 表新增 priority 列，默认 100；路由按优先级降序、同级按权重随机。' },
  { key: 'e-old', title: '翻译：Liquid Glass 设计指南', folder: FOLDERS.none, at: () => ago(40 * DAY), preview: '已翻译全文 6 章，术语表附在末尾；“材质”统一译为 material 的意译“材质层”。' },
];
const demoUuid = (key) => {
  const hex = crypto.createHash('sha1').update(`openbear-demo:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const demoByUuid = new Map(DEMO_LIST.map((d) => [demoUuid(d.key), d]));

function demoListItem(demo) {
  const uuid = demoUuid(demo.key);
  const at = demo.at();
  const live = conversations.get(uuid)?.loaded;
  const replaying = Boolean(live?.running);
  const running = Boolean(demo.running) || replaying;
  const startedMs = demo.startedAgo ? Date.now() - demo.startedAgo * 1000 : at * 1000;
  const pending = demo.waiting ? [{ kind: 'ask_user', opId: `ask:${uuid}` }] : [];
  const version = demo.unread ? 7 : 6;
  const result = demo.failed ? { status: 'failed', atMs: at * 1000 } : running ? {} : { status: 'completed', atMs: at * 1000 };
  const minutes = Math.max(1, Math.round((Date.now() - startedMs) / 60000));
  return {
    conversationUuid: uuid,
    title: demo.title,
    folderId: demo.folder.id,
    path: demo.folder.path,
    origin: 'user',
    pinned: Boolean(demo.pinned),
    pinnedAt: demo.pinned ? at - 10 * DAY : 0,
    archived: false,
    archivedAt: 0,
    createdAt: at - 2 * DAY,
    lastConversationAt: at,
    updatedAt: at,
    running,
    status: running ? 'running' : 'idle',
    currentStatus: demo.waiting ? '等待回答' : running ? `运行中 · ${minutes} 分钟` : demo.failed ? '执行失败' : '就绪',
    activityState: running ? (demo.waiting ? 'waiting' : 'running') : demo.failed ? 'failed' : demo.unread ? 'completed' : 'idle',
    activityPending: pending,
    activityUnread: Boolean(demo.unread),
    activityVersion: version,
    activityReadVersion: 6,
    activityResult: result,
    operationCount: 12 + (demo.title.length * 37) % 400,
    activeCount: running ? 1 : 0,
    pendingInteractionCount: pending.length,
    activeStartedAtMs: running ? startedMs : 0,
    latestUpdatedAtMs: at * 1000,
    preview: demo.preview,
    demo: true,
  };
}

/** 虚拟会话的最小内容：一条用户消息 + 一条“该会话为演示数据”的回答（结构取自真实操作）。 */
function demoLoaded(uuid, demo) {
  const templateDir = path.join(BENCH, 'conv', 'd8e18cc9-d50b-48b3-b44a-0e8b107de4ca');
  const stateBase = readJson(path.join(templateDir, 'state-base.json'));
  const firstPage = readJson(path.join(templateDir, 'pages-50.json'))[0].operations;
  const turnId = demoUuid(`${demo.key}:turn`);
  const atMs = demo.at() * 1000;
  const pick = (type) => firstPage.find((op) => op.opType === type);
  const rewrite = (op, extra) => ({
    ...op,
    conversationId: uuid,
    conversationUuid: uuid,
    turnId,
    turnUuid: turnId,
    runRootTurnId: turnId,
    runId: turnId,
    targetId: turnId,
    transcriptMessageIds: [],
    createdAtMs: atMs,
    updatedAtMs: atMs,
    terminalAtMs: atMs,
    ...extra,
  });
  const runOp = pick('run');
  const userOp = pick('user_message');
  const answerOp = pick('assistant_message');
  const operations = [
    rewrite(runOp, { opId: `run:${turnId}`, displaySeq: 10, operationOrder: 1, payload: { ...runOp.payload, turnId, runId: turnId, transcriptMessageIds: [], startedAtMs: atMs, completedAtMs: atMs, terminalAtMs: atMs } }),
    rewrite(userOp, { opId: `msg:${turnId}`, displaySeq: 20, operationOrder: 2, payload: { ...userOp.payload, text: demo.title, transcriptMessageIds: [], createdAtMs: atMs, terminalAtMs: atMs } }),
    rewrite(answerOp, { opId: `assistant:${turnId}:1`, displaySeq: 30, operationOrder: 3, payload: { ...answerOp.payload, text: `该会话为演示数据，仅用于展示会话列表。\n\n> ${demo.preview}`, transcriptMessageIds: [] } }),
  ];
  const page = { operations, hasMoreBefore: false, nextBeforeDisplaySeq: 0, beforeDisplaySeq: null };
  const conversation = { ...stateBase.conversation, ...demoListItem(demo) };
  delete conversation.benchOperationCount;
  return {
    stateBase: { ...stateBase, conversationUuid: uuid, frameSeq: 0, messages: [], pendingConfirmations: [], pendingSteering: [], conversation },
    chains: { 200: [page], 50: [page] },
    details: new Map(),
    frames: [],
    liveFrames: [],
    liveOps: new Map(),
    frameSeq: 0,
    maxDisplaySeq: 30,
    running: false,
    sockets: new Set(),
  };
}

function load(uuid) {
  if (!conversations.has(uuid) && demoByUuid.has(uuid)) conversations.set(uuid, { info: { conversationUuid: uuid, frameSeq: 0 }, loaded: demoLoaded(uuid, demoByUuid.get(uuid)) });
  const entry = conversations.get(uuid);
  if (!entry) return null;
  if (!entry.loaded) {
    const dir = path.join(BENCH, 'conv', uuid);
    const t0 = Date.now();
    const chains = {};
    for (const file of fs.readdirSync(dir)) {
      const m = /^pages-(\d+)\.json$/.exec(file);
      if (m) chains[m[1]] = readJson(path.join(dir, file));
    }
    const details = new Map();
    for (const line of fs.readFileSync(path.join(dir, 'details.jsonl'), 'utf8').split('\n')) {
      if (!line) continue;
      const op = JSON.parse(line);
      details.set(op.opId, op);
    }
    const frames = readJson(path.join(dir, 'frames.json'));
    entry.loaded = {
      stateBase: readJson(path.join(dir, 'state-base.json')),
      chains,
      details,
      frames,
      // 回放追加的帧/操作（内存，进程重启即丢）
      liveFrames: [],
      liveOps: new Map(),
      frameSeq: entry.info.frameSeq,
      maxDisplaySeq: Math.max(0, ...Object.values(chains).flatMap((c) => c[0]?.operations || []).map((o) => o.displaySeq || 0)),
      running: false,
      sockets: new Set(),
    };
    log(`loaded ${uuid} in ${Date.now() - t0}ms`);
  }
  return entry.loaded;
}

function pickChain(data, limit) {
  const keys = Object.keys(data.chains).map(Number).sort((a, b) => a - b);
  const exact = keys.find((k) => k === limit);
  if (exact) return data.chains[String(exact)];
  // 没有导出该 limit 的页链时用最接近的（报告中说明：只导出了 200 和 50 两种）
  const nearest = keys.reduce((best, k) => (Math.abs(k - limit) < Math.abs(best - limit) ? k : best), keys[0]);
  return data.chains[String(nearest)];
}

function pageFor(data, limit, before) {
  const chain = pickChain(data, limit);
  const page = before
    ? chain.find((p) => Number(p.beforeDisplaySeq || 0) === Number(before)) ||
      // 非页链边界的游标：用包含该游标的下一页
      chain.find((p) => p.beforeDisplaySeq && p.beforeDisplaySeq <= before) ||
      chain[chain.length - 1]
    : chain[0];
  let operations = page.operations;
  if (!before && data.liveOps.size) {
    const byId = new Map(operations.map((op) => [op.opId, op]));
    for (const op of data.liveOps.values()) byId.set(op.opId, op);
    operations = [...byId.values()].sort((a, b) => a.displaySeq - b.displaySeq || (a.operationOrder || 0) - (b.operationOrder || 0));
  }
  return {
    operations,
    hasMoreBefore: page.hasMoreBefore,
    nextBeforeDisplaySeq: page.nextBeforeDisplaySeq,
    timelineLimit: limit,
    beforeDisplaySeq: before || null,
  };
}

function conversationList() {
  const real = manifest.conversations.map((info) => {
    const data = conversations.get(info.conversationUuid).loaded;
    const base = data?.stateBase.conversation || { conversationUuid: info.conversationUuid, title: info.title };
    const running = Boolean(data?.running);
    const extra = REAL_LIST_OVERRIDES[info.conversationUuid]?.() || { folder: FOLDERS.none, lastConversationAt: base.updatedAt || 0 };
    const startedMs = running ? data.runStartedAtMs || Date.now() : 0;
    const unread = Boolean(extra.activityUnread);
    return {
      ...base,
      title: info.title,
      folderId: extra.folder.id,
      path: extra.folder.path,
      origin: base.origin || 'user',
      pinned: Boolean(extra.pinned),
      pinnedAt: extra.pinned ? extra.pinnedAt : 0,
      archived: false,
      archivedAt: 0,
      lastConversationAt: running ? Math.floor(Date.now() / 1000) : extra.lastConversationAt,
      running,
      status: running ? 'running' : 'idle',
      currentStatus: running ? `运行中 · ${Math.max(1, Math.round((Date.now() - startedMs) / 60000))} 分钟` : '就绪',
      activityState: running ? 'running' : unread ? 'completed' : 'idle',
      activityPending: [],
      activityUnread: unread,
      activityVersion: unread ? (base.activityVersion || 0) + 1 : base.activityVersion || 0,
      activityReadVersion: base.activityReadVersion || 0,
      operationCount: info.operationCount + (data?.liveOps.size || 0),
      activeCount: running ? 1 : 0,
      pendingInteractionCount: 0,
      activeStartedAtMs: startedMs,
      latestUpdatedAtMs: (running ? Math.floor(Date.now() / 1000) : extra.lastConversationAt) * 1000,
      preview: extra.preview || '',
    };
  });
  return [...real, ...DEMO_LIST.map(demoListItem)];
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

function hasSession(req) {
  return String(req.headers.cookie || '').split(/;\s*/).some((c) => c === `${COOKIE}=${SESSION_TOKEN}`);
}

const sessionCookie = `${COOKIE}=${SESSION_TOKEN}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const started = Date.now();
  if (LATENCY_MS) await new Promise((r) => setTimeout(r, LATENCY_MS));
  try {
    if (url.pathname === '/api/auth/mode') return json(res, 200, { ok: true, mode: 'controller' });
    // 模拟后端的“登录”：直接发会话 Cookie。真实后端的 Secret Key + Telegram 审批流程见 src/transport/auth.ts（待联调）。
    if (url.pathname === '/api/mock/login' && req.method === 'POST') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie });
    }
    if (url.pathname === '/api/auth/session') {
      if (!hasSession(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      return json(res, 200, { ok: true, chatId: 1, expiresAt: 0, mode: 'controller' });
    }
    if (parts[0] === 'api' && !hasSession(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    // 开发专用：Markdown 对比用例（scripts/md-compare/build_cases.mjs 生成），App 的 /mdlab 页面读取
    if (url.pathname === '/api/mock/md-cases') {
      const file = path.join(BENCH, 'md-cases.json');
      return json(res, fs.existsSync(file) ? 200 : 404, fs.existsSync(file) ? readJson(file) : { ok: false });
    }
    if (url.pathname === '/api/conversations') {
      return json(res, 200, { ok: true, items: conversationList(), activeConversationUuid: manifest.conversations[0].conversationUuid });
    }
    if (parts[0] === 'api' && parts[1] === 'conversations' && parts[2]) {
      const uuid = parts[2];
      const data = load(uuid);
      if (!data) return json(res, 404, { ok: false, error: 'conversation_not_found' });
      const limit = url.searchParams.has('timelineLimit') ? Number(url.searchParams.get('timelineLimit') || 200) : null;
      const before = Number(url.searchParams.get('beforeDisplaySeq') || 0) || null;
      if (parts[3] === 'state') {
        const page = pageFor(data, limit || 200, before);
        const body = {
          ...data.stateBase,
          running: data.running,
          operations: page.operations,
          frameSeq: data.frameSeq,
          hasMoreBefore: page.hasMoreBefore,
          nextBeforeDisplaySeq: page.nextBeforeDisplaySeq,
          timelineLimit: page.timelineLimit,
          beforeDisplaySeq: page.beforeDisplaySeq,
          facts: { latestFrameSeq: data.frameSeq },
          conversation: { ...data.stateBase.conversation, running: data.running },
        };
        log(`GET state ${uuid.slice(0, 8)} ops=${page.operations.length} ${Date.now() - started}ms`);
        return json(res, 200, body);
      }
      if (parts[3] === 'operations' && parts[4] && parts[5] === 'detail') {
        const op = data.details.get(parts[4]) || data.liveOps.get(parts[4]);
        if (!op) return json(res, 404, { ok: false, error: 'operation_detail_not_found' });
        return json(res, 200, { ok: true, conversationUuid: uuid, operation: op });
      }
      if (parts[3] === 'operations') {
        const page = pageFor(data, limit || 200, before);
        log(`GET operations ${uuid.slice(0, 8)} before=${before} ops=${page.operations.length}`);
        return json(res, 200, { ok: true, conversationUuid: uuid, ...page });
      }
      if (parts[3] === 'frames') {
        const after = Number(url.searchParams.get('afterFrameSeq') || 0);
        const max = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') || 1000)));
        const frames = [...data.frames, ...data.liveFrames].filter((f) => f.frameSeq > after).slice(0, max);
        return json(res, 200, { ok: true, conversationUuid: uuid, frames, frameSeq: frames.length ? frames.at(-1).frameSeq : after });
      }
    }
    json(res, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    log('error', error);
    json(res, 500, { ok: false, error: String(error?.message || error) });
  }
});

// ---- WebSocket ----
const convWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024 });
const eventWss = new WebSocketServer({ noServer: true });
const eventSockets = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (!hasSession(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.pathname === '/api/events/ws') {
    return eventWss.handleUpgrade(req, socket, head, (ws) => onEventSocket(ws));
  }
  if (parts[0] === 'api' && parts[1] === 'conversations' && parts[3] === 'ws') {
    const data = load(parts[2]);
    if (!data) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    return convWss.handleUpgrade(req, socket, head, (ws) => onConversationSocket(ws, parts[2], data, url));
  }
  socket.destroy();
});

function send(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function broadcastEvents(payload) {
  for (const ws of eventSockets) send(ws, payload);
}

function onEventSocket(ws) {
  eventSockets.add(ws);
  send(ws, { type: 'snapshot', epoch: 'mock', seq: 1, items: conversationList(), includeArchived: false, version: 1 });
  ws.on('message', (raw) => {
    let data = {};
    try { data = JSON.parse(String(raw)); } catch { /* ignore */ }
    if (data.type === 'ping') send(ws, { type: 'pong' });
  });
  ws.on('close', () => eventSockets.delete(ws));
}

function onConversationSocket(ws, uuid, data, url) {
  data.sockets.add(ws);
  const after = Number(url.searchParams.get('afterFrameSeq') || 0);
  const incremental = url.searchParams.get('bootstrap') === 'incremental';
  log(`WS open ${uuid.slice(0, 8)} after=${after} incremental=${incremental}`);
  if (incremental) {
    const gap = [...data.frames, ...data.liveFrames].filter((f) => f.frameSeq > after);
    for (const frame of gap) send(ws, { type: 'frame', frame });
    send(ws, { type: 'bootstrap', messageVisibility: {}, frameSeq: data.frameSeq, pendingConfirmations: [], pendingSteering: [] });
  }
  ws.on('message', (raw) => {
    let msg = {};
    try { msg = JSON.parse(String(raw)); } catch { return send(ws, { type: 'error', error: 'bad_json' }); }
    if (msg.type === 'ping') return send(ws, { type: 'pong', ts: Math.floor(Date.now() / 1000) });
    if (msg.type === 'send') {
      const text = String(msg.text || '').trim();
      if (!text) return send(ws, { type: 'error', error: 'empty_text', requestId: msg.requestId || '' });
      if (data.running) return send(ws, { type: 'error', error: 'busy', requestId: msg.requestId || '' });
      send(ws, { type: 'ack', requestId: msg.requestId || '', ok: true });
      replay(uuid, data, text, Number(msg.streamIndex || 0));
      return undefined;
    }
    if (msg.type === 'stop') {
      // 与真实后端一致：停止当前运行、推终止帧（run/tool cancel，正文/思考 end，status end），再回 stopped。
      const wasRunning = Boolean(data.running && data.stopReplay);
      if (wasRunning) data.stopReplay();
      log(`WS stop ${uuid.slice(0, 8)} running=${wasRunning}`);
      return send(ws, { type: 'stopped', ok: true, stoppedRun: wasRunning });
    }
    return send(ws, { type: 'error', error: 'unknown_command' });
  });
  ws.on('close', () => data.sockets.delete(ws));
}

/** 把一段真实流式帧重写到目标对话尾部并按原始节奏推送。 */
function replay(uuid, data, userText, streamIndex) {
  const sample = streams[streamIndex % streams.length];
  const turnId = crypto.randomUUID();
  const idMap = new Map();
  const mapId = (value) => {
    if (!value) return value;
    if (!idMap.has(value)) idMap.set(value, value.replaceAll(sample.turnUuid, turnId) + (value.includes(sample.turnUuid) ? '' : `:${turnId.slice(0, 8)}`));
    return idMap.get(value);
  };
  const displayBase = data.maxDisplaySeq + 10;
  const sourceDisplayBase = Math.min(...sample.frames.map((f) => f.displaySeq || 0).filter(Boolean));
  data.running = true;
  data.runStartedAtMs = Date.now();
  data.stopRequested = false;
  broadcastEvents({ type: 'patch', epoch: 'mock', seq: Date.now(), upserts: conversationList().filter((c) => c.conversationUuid === uuid), removed: [] });
  log(`replay ${sample.name} -> ${uuid.slice(0, 8)} frames=${sample.frames.length} speed=${SPEED}`);
  const t0 = Date.now();
  let index = 0;
  let timer = null;
  const finish = (reason) => {
    data.running = false;
    data.stopReplay = null;
    data.maxDisplaySeq = Math.max(data.maxDisplaySeq, ...[...data.liveOps.values()].map((o) => o.displaySeq));
    broadcastEvents({ type: 'patch', epoch: 'mock', seq: Date.now(), upserts: conversationList().filter((c) => c.conversationUuid === uuid), removed: [] });
    log(`replay ${reason} in ${Date.now() - t0}ms`);
  };
  // 停止：取消后续回放，给本轮仍未终止的操作各推一个终止帧（revision 续接，帧是事实、快照同步更新）。
  data.stopReplay = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    data.stopRequested = true;
    const now = Date.now();
    for (const op of [...data.liveOps.values()]) {
      if (op.lifecycle === 'terminal' || String(op.turnId || '') !== turnId) continue;
      let action = 'end';
      let payload = {};
      if (op.opType === 'run') { action = 'cancel'; payload = { runId: turnId, status: 'cancelled', terminalAtMs: now }; }
      else if (op.opType === 'tool' || op.opType === 'agent') { action = 'cancel'; payload = { status: 'cancelled', reason: '已停止', terminalAtMs: now }; }
      else if (op.opType === 'assistant_message' || op.opType === 'reasoning') { payload = { complete: true, terminalAtMs: now }; }
      else if (op.opType === 'status') { payload = { active: false, statusText: '已停止', status: 'cancelled', terminalAtMs: now }; }
      else continue;
      const { status: _s, lifecycle: _l, terminalAtMs: _t, ...base } = op;
      pushFrame({ ...base, payload, action, revision: Number(op.revision || 0) + 1, frameSeq: ++data.frameSeq, createdAtMs: now, updatedAtMs: now });
    }
    finish('stopped');
  };
  const pushFrame = (frame) => {
    data.liveFrames.push(frame);
    // 维护一个简化的服务端快照，供重新进入对话时 /state 返回（与真实后端一样：帧是事实，快照是投影）
    const prev = data.liveOps.get(frame.opId);
    const payload = { ...(prev?.payload || {}), ...frame.payload };
    if ('delta' in frame.payload && !frame.payload.snapshot) payload.text = String(prev?.payload?.text || '') + String(frame.payload.delta || '');
    delete payload.delta;
    data.liveOps.set(frame.opId, {
      ...(prev || {}),
      ...frame,
      displaySeq: prev?.displaySeq || frame.displaySeq,
      createdAtMs: prev?.createdAtMs || frame.createdAtMs,
      status: payload.status || prev?.status || '',
      lifecycle: ['end', 'error', 'cancel', 'stop'].includes(frame.action) ? 'terminal' : prev?.lifecycle || 'active',
      payload,
    });
    for (const ws of data.sockets) send(ws, { type: 'frame', frame });
  };
  const step = () => {
    timer = null;
    if (data.stopRequested) return;
    if (index >= sample.frames.length) {
      finish('done');
      return;
    }
    const source = sample.frames[index];
    const frame = {
      ...source,
      conversationId: uuid,
      conversationUuid: uuid,
      frameSeq: ++data.frameSeq,
      turnId: source.turnId === sample.turnUuid ? turnId : mapId(source.turnId),
      turnUuid: source.turnUuid === sample.turnUuid ? turnId : mapId(source.turnUuid),
      runRootTurnId: source.runRootTurnId ? turnId : '',
      opId: mapId(source.opId),
      runId: source.runId ? turnId : source.runId,
      targetId: source.targetType === 'run' ? turnId : source.targetId,
      displaySeq: source.displaySeq ? displayBase + (source.displaySeq - sourceDisplayBase) : 0,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      payload: { ...source.payload, ...(source.payload?.runId ? { runId: turnId } : {}) },
    };
    delete frame.replayOffsetMs;
    if (frame.opType === 'user_message' && frame.action === 'create') frame.payload = { ...frame.payload, text: userText };
    pushFrame(frame);
    index += 1;
    const next = sample.frames[index];
    const wait = next ? Math.max(0, (next.replayOffsetMs - source.replayOffsetMs) / SPEED) : 0;
    timer = setTimeout(step, Math.min(wait, 4000 / SPEED));
  };
  step();
}

// 预加载全部基准对话，让计时反映客户端而不是模拟后端首次读盘（--no-preload 关闭）
if (!process.argv.includes('--no-preload')) for (const uuid of conversations.keys()) load(uuid);

server.listen(PORT, '0.0.0.0', () => {
  log(`OpenBear mock backend on http://0.0.0.0:${PORT} (Android emulator: http://10.0.2.2:${PORT}) bench=${BENCH} speed=${SPEED}`);
  log(`conversations: ${manifest.conversations.map((c) => `${c.conversationUuid.slice(0, 8)}(${c.operationCount})`).join(', ')}`);
});

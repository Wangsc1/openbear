import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {parse, compileTemplate} from "@vue/compiler-sfc";
import {ref} from "vue";
import {conversationTimelineEntries} from "./conversationTimeline.js";
import {replyMarkdownText, replyShareCapabilities} from "./replyMarkdownShare.js";

const answer = (content, reasoning = "") => ({kind: "answer", message: {content, reasoning}});
const entries = conversationTimelineEntries([
  answer("  # 标题\n\n[附件](workspace/file.txt)\n", "私密思考"),
  {kind: "tool", message: {content: "工具输出"}},
  answer("```md\n**原文**\n```\n", "另一段思考"),
]);

test("share text selects only visible answer entries and preserves original Markdown bytes", () => {
  assert.equal(replyMarkdownText(entries), "  # 标题\n\n[附件](workspace/file.txt)\n\n\n```md\n**原文**\n```\n");
  assert.equal(replyMarkdownText(entries.filter(({event}) => event !== entries.at(-1).event)), "  # 标题\n\n[附件](workspace/file.txt)\n");
  assert.equal(replyMarkdownText(conversationTimelineEntries([answer("", "只含推理")])), "");
  assert.equal(replyMarkdownText([{event: answer(" \n ")}]), "");
});

class FakeFile {
  constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; }
}

test("secure context and file canShare are checked separately, without file-to-text substitution", () => {
  const sent = [];
  const nav = {share: payload => { sent.push(payload); return Promise.resolve(); }, canShare: payload => !payload.files};
  const text = "# 测试\n";
  assert.equal(replyShareCapabilities(text, {navigator: nav, secure: false, FileClass: FakeFile}).text, false);
  assert.equal(replyShareCapabilities(text, {navigator: nav, secure: true, FileClass: FakeFile}).text, true);
  assert.equal(replyShareCapabilities(text, {navigator: nav, secure: true, FileClass: FakeFile}).file, null);
  const fileOnly = {share: nav.share, canShare: payload => Boolean(payload.files)};
  const capabilities = replyShareCapabilities(text, {navigator: fileOnly, secure: true, FileClass: FakeFile});
  assert.equal(capabilities.text, false);
  assert.equal(capabilities.file.name, "openbear-reply.md");
  assert.deepEqual(capabilities.file.parts, [text]);
  assert.match(capabilities.file.type, /^text\/markdown/);
  assert.equal(replyShareCapabilities(text, {navigator: {share: nav.share}, secure: true}).file, null);
  assert.equal(replyShareCapabilities(text, {navigator: {}, secure: true}).text, false);
  assert.equal(sent.length, 0, "capability detection cannot send content");
});

const source = readFileSync(new URL("./ReplyMarkdownShare.vue", import.meta.url), "utf8");
const {descriptor, errors} = parse(source);
assert.deepEqual(errors, []);
assert.deepEqual(compileTemplate({source: descriptor.template.content, filename: "ReplyMarkdownShare.vue", id: "reply-share"}).errors, []);

function shareComponent({secure = true, canShare = () => true, share = () => Promise.resolve(), initial = "# 原文\n"} = {}) {
  const props = {content: initial};
  const copies = [], downloads = [], timers = [];
  let contentWatcher, unmount;
  const nav = {canShare, share};
  const document = {body: {appendChild() {}}, createElement: () => ({style: {}, click() { downloads.push({href: this.href, download: this.download}); }, remove() {}})};
  const objectUrls = {createObjectURL: blob => { downloads.push(blob); return "blob:local"; }, revokeObjectURL: url => downloads.push(url)};
  const code = descriptor.scriptSetup.content.replace(/^import .*;\n/gm, "");
  const context = vm.createContext({ref, watch: (_, fn) => { contentWatcher = fn; }, onBeforeUnmount: fn => { unmount = fn; },
    replyShareCapabilities, copyTextToClipboard: async text => { copies.push(text); },
    defineProps: () => props, navigator: nav, File: FakeFile, Blob, URL: objectUrls, document,
    window: {setTimeout: callback => { timers.push(callback); }}, isSecureContext: secure});
  vm.runInContext(code, context);
  return {props, nav, copies, downloads, timers, run: code => vm.runInContext(code, context), update(text) { props.content = text; contentWatcher(); }, unmount: () => unmount()};
}

test("real share component requires selection and preserves text vs file payload", async () => {
  const payloads = [];
  const c = shareComponent({share: data => { payloads.push(data); return Promise.resolve(); }});
  assert.equal(payloads.length, 0);
  c.run("open()");
  assert.equal(c.run("shown.value"), true);
  assert.equal(c.run("textAvailable.value"), true);
  await c.run("send('text')");
  assert.deepEqual(Object.keys(payloads[0]), ["text"]);
  assert.equal(payloads[0].text, "# 原文\n");
  await c.run("send('file')");
  assert.deepEqual(Object.keys(payloads[1]), ["files"]);
  assert.equal(payloads[1].files[0].name, "openbear-reply.md");
  assert.deepEqual(payloads[1].files[0].parts, ["# 原文\n"]);
  await c.run("copy()");
  assert.deepEqual(c.copies, ["# 原文\n"]);
  c.run("download()");
  assert.equal(c.downloads[1].download, "openbear-reply.md");
  assert.equal(await c.downloads[0].text(), "# 原文\n");
  c.timers[0]();
  assert.equal(c.downloads[2], "blob:local");
  c.unmount();
});

test("file-only capability never silently sends a text payload", async () => {
  const payloads = [];
  const c = shareComponent({canShare: payload => Boolean(payload.files), share: payload => { payloads.push(payload); return Promise.resolve(); }});
  c.run("open()");
  assert.equal(c.run("textAvailable.value"), false);
  assert.equal(c.run("shareFile.value.name"), "openbear-reply.md");
  await c.run("send('text')");
  assert.equal(payloads.length, 0);
  await c.run("send('file')");
  assert.equal(payloads.length, 1);
  assert.deepEqual(Object.keys(payloads[0]), ["files"]);
});

test("unsupported sharing falls back to copy/download, cancellation isn't a failure, changed content cannot leak", async () => {
  let calls = 0;
  const c = shareComponent({secure: false, share: () => { calls++; return Promise.resolve(); }});
  c.run("open()");
  assert.equal(c.run("textAvailable.value"), false);
  assert.equal(c.run("shareFile.value"), null);
  await c.run("send('text')");
  await c.run("send('file')");
  assert.equal(calls, 0);
  await c.run("copy()");
  assert.deepEqual(c.copies, ["# 原文\n"]);
  c.update("# 新内容");
  await c.run("send('text')");
  assert.equal(c.run("shown.value"), false);
  const cancelled = shareComponent({share: () => Promise.reject({name: "AbortError"})});
  cancelled.run("open()");
  await cancelled.run("send('file')");
  assert.match(cancelled.run("message.value"), /已取消分享/);
  assert.doesNotMatch(cancelled.run("message.value"), /失败/);
  assert.equal(cancelled.run("sharing.value"), false);
  const denied = shareComponent({share: () => Promise.reject({name: "NotAllowedError"})});
  denied.run("open()");
  await denied.run("send('text')");
  assert.match(denied.run("message.value"), /复制\/下载/);
});

test("share dialog delegates mask dismissal, Escape, focus and body scroll to the existing dialog", () => {
  assert.match(descriptor.scriptSetup.content, /import \{ElDialog\} from "element-plus"/);
  assert.match(descriptor.template.content, /<ElDialog[\s\S]*v-model="shown"[\s\S]*append-to-body destroy-on-close/);
  assert.match(descriptor.template.content, /:close-on-click-modal="true"/);
  assert.match(descriptor.template.content, /:close-on-press-escape="true" @close="close"/);
  assert.match(descriptor.template.content, /:id="titleId"/);
  assert.match(descriptor.template.content, /aria-label="关闭分享回复" @click="close"/);
  const c = shareComponent();
  c.run("open()");
  // ElDialog's mask and Escape paths emit this same close event.
  c.run("close()");
  assert.equal(c.run("shown.value"), false);
  assert.equal(c.run("selectedText"), "");
  assert.equal(c.run("shareFile.value"), null);
  c.run("open()");
  assert.equal(c.run("shown.value"), true);
});

test("closing while the system share is pending cannot update a reopened dialog", async () => {
  let resolve;
  const c = shareComponent({share: () => new Promise(done => {resolve = done;})});
  c.run("open()");
  const pending = c.run("send('text')");
  c.run("close(); open()");
  resolve();
  await pending;
  assert.equal(c.run("message.value"), "");
  assert.equal(c.run("sharing.value"), false);
  assert.equal(c.run("shown.value"), true);
});

test("mobile share layout is viewport-bounded, has separated actions and theme-aware styling", () => {
  const css = descriptor.styles[0].content;
  assert.match(css, /reply-share-modal \.el-overlay-dialog[\s\S]*align-items: flex-end/);
  assert.match(css, /height: var\(--mobile-viewport-height, 100%\)/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /\.reply-share-dialog > \.el-dialog__body[^}]*overflow-y: auto/);
  assert.match(css, /\.reply-share-utilities[^}]*grid-template-columns/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("TurnList adds share only beside assistant reply actions and uses visible timeline text", () => {
  const parent = readFileSync(new URL("./TurnList.vue", import.meta.url), "utf8");
  assert.match(parent, /function assistantTurnShareContent\(turn\) \{\s*return replyMarkdownText\(conversationEvents\(turn\)\);/);
  assert.match(parent, /<span class="message-footer-actions">[\s\S]*<ReplyMarkdownShare v-if="!visibility\.selecting\.value && assistantTurnShareContent\(turn\)" :content="assistantTurnShareContent\(turn\)"\/>/);
  assert.match(descriptor.styles[0].content, /@media \(max-width: 760px\)/);
  assert.match(descriptor.template.content, /分享 Markdown 文本…[\s\S]*分享 \.md 文件…[\s\S]*复制 Markdown[\s\S]*下载 \.md 文件/);
  assert.match(descriptor.template.content, /附件文件不会打包进 \.md/);
});

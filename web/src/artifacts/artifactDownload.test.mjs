import test, {after, afterEach} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {register} from "node:module";
import vm from "node:vm";
import {compileScript, compileTemplate, parse} from "@vue/compiler-sfc";
import {createRenderer, h, nextTick, ref} from "vue";
import {artifactFromUrl, clearArtifactCache} from "./artifactFiles.js";
import {onArtifactDownload, readShareFile, SHARE_FILE_LIMIT} from "./artifactDownload.js";

const href = "/api/conversations/39a541d4-4d9c-4a58-87d6-1b276779954a/artifacts/adfead18-e6d1-40df-8475-391e1245aa0d/content";
const identity = artifactFromUrl(href, "https://openbear.test");
const meta = (extra = {}) => ({conversationUuid: identity.conversationUuid, artifactUuid: identity.artifactUuid, fileName: "原图.png", mimeType: "image/png", sizeBytes: 4, ...extra});
const original = Object.fromEntries(["window", "navigator", "location", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
after(() => { for (const [key, desc] of Object.entries(original)) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; } });
afterEach(() => clearArtifactCache());
let win = new EventTarget();
win.navigator = {userAgent: "iPhone", standalone: true, share: () => Promise.resolve(), canShare: () => true};
win.matchMedia = () => ({matches: win.navigator.standalone === true});
Object.defineProperty(globalThis, "window", {configurable: true, get: () => win});
Object.defineProperty(globalThis, "navigator", {configurable: true, get: () => win.navigator});
Object.defineProperty(globalThis, "location", {configurable: true, value: {origin: "https://openbear.test"}});
const tick = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
const clickEvent = (extra = {}) => ({defaultPrevented: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra});

const filename = "ArtifactDownload.vue";
const {descriptor} = parse(readFileSync(new URL(filename, import.meta.url), "utf8"), {filename});
register(`data:text/javascript,${encodeURIComponent(`
 let source;
 export function initialize(s) { source = s; }
 export function resolve(specifier, context, next) { return next(specifier, context); }
 export function load(url, context, next) {
  if (url.endsWith('/ArtifactDownload.vue')) return {format:'module', source, shortCircuit:true};
  return next(url, context);
 }
`)}`, {parentURL: import.meta.url, data: compileScript(descriptor, {id: filename, inlineTemplate: true}).content});
const Component = (await import("./ArtifactDownload.vue")).default;
const node = (type, text = "") => ({type, text, props: {}, children: [], parent: null});
const body = node("body");
const renderer = createRenderer({
 querySelector: target => target === "body" ? body : null,
 createElement: type => node(type), createText: text => node("#text", text), createComment: text => node("#comment", text),
 setText(n, value) { n.text = value; }, setElementText(n, value) { n.text = value; n.children = []; }, patchProp(n, key, old, value) { n.props[key] = value; },
 insert(n, parent, anchor = null) { if (n.parent) this.remove(n); n.parent = parent; const i = parent.children.indexOf(anchor); parent.children.splice(i < 0 ? parent.children.length : i, 0, n); },
 remove(n) { const i = n.parent?.children.indexOf(n) ?? -1; if (i >= 0) n.parent.children.splice(i, 1); n.parent = null; },
 parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
});
const walk = n => [n, ...n.children.flatMap(walk)];
const text = n => [n.type === "#comment" ? "" : n.text, ...n.children.map(text)].join("");
const navigationKey = ref("conversation-a");
function mount(t) { const root = node("root"); const app = renderer.createApp({render: () => h(Component, {navigationKey: navigationKey.value})}); app.mount(root); t.after(() => app.unmount()); return body; }
function control(root, label) { const result = walk(root).find(n => ["button", "a"].includes(n.type) && text(n).includes(label)); assert.ok(result, `missing ${label}: ${text(root)}`); return result; }
function start() { win.dispatchEvent(new CustomEvent("openbear:download-artifact", {detail: {href}})); }
function fetchFile(bytes = Uint8Array.of(0, 127, 255, 10)) {
 const calls = [];
 globalThis.fetch = async (url, options) => { calls.push({url, options}); return url === identity.metadataUrl ? Response.json({artifact: meta({sizeBytes: bytes.byteLength})}) : new Response(bytes, {headers: {"Content-Type": "image/png"}}); };
 return calls;
}

test("real save-panel SFC template compiles; all entry points retain canonical attachment links", () => {
 for (const path of ["ArtifactDownload.vue", "ArtifactCard.vue", "ArtifactImagePath.vue", "ArtifactPreview.vue", "../views/consoleView/ConsoleMarkdown.vue"]) {
  const {descriptor: part} = parse(readFileSync(new URL(path, import.meta.url), "utf8"), {filename: path});
  assert.deepEqual(compileTemplate({source: part.template.content, filename: path, id: path}).errors, []);
  if (path === "ArtifactDownload.vue") continue;
  const source = part.template.content;
  if (path === "../views/consoleView/ConsoleMarkdown.vue") {
   assert.match(part.scriptSetup.content, /artifact\?\.download\) \{ onArtifactDownload\(event, artifact\)/);
  } else {
   assert.match(source, /onArtifactDownload\(/, path); assert.match(source, /download/, path);
  }
 }
});

test("ordinary browsers and desktop PWA keep native downloads; Android and iOS PWA open the save panel", () => {
 const emitted = [];
 const listen = e => emitted.push(e.detail.href);
 win.addEventListener("openbear:download-artifact", listen);
 try {
  for (const overrides of [{userAgent: "Macintosh", standalone: false}, {userAgent: "Windows NT 10.0", standalone: true}, {userAgent: "Android", standalone: false}, {userAgent: "iPhone", standalone: false}]) {
   win.navigator = {...win.navigator, ...overrides};
   const event = clickEvent(); assert.equal(onArtifactDownload(event, identity), false); assert.equal(event.prevented, false);
  }
  for (const userAgent of ["Android", "iPhone"]) {
   win.navigator = {...win.navigator, userAgent, standalone: true};
   for (const modifier of [{metaKey:true}, {ctrlKey:true}, {shiftKey:true}, {altKey:true}, {button:1}, {defaultPrevented:true}]) {
    const modified = clickEvent(modifier); assert.equal(onArtifactDownload(modified, identity), false); assert.equal(modified.prevented, false);
   }
   const event = clickEvent(); assert.equal(onArtifactDownload(event, identity), true);
   assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  }
  assert.deepEqual(emitted, [href, href]);
 } finally { win.removeEventListener("openbear:download-artifact", listen); }
});

test("real Markdown click handler previews ordinary artifact links but preserves explicit download on desktop and intercepts both mobile PWA platforms", () => {
 const source = readFileSync(new URL("../views/consoleView/ConsoleMarkdown.vue", import.meta.url), "utf8");
 const body = source.slice(source.indexOf("function onMarkdownClick(event) {"), source.indexOf("\n</script>"));
 const previews = [], intercepted = [];
 const context = {artifactFromUrl: url => artifactFromUrl(url, "https://openbear.test"), openArtifactPreview: (...args) => previews.push(args), onArtifactDownload: (event, artifact) => { intercepted.push(artifact); return onArtifactDownload(event, artifact); }};
 vm.runInNewContext(`${body}\nthis.onClick = onMarkdownClick;`, context);
 const link = url => ({getAttribute: () => url, textContent: "附件", closest: () => null});
 const event = url => ({...clickEvent(), target: {closest: query => query === "a[href]" ? link(url) : null}});
 const preview = event(href); context.onClick(preview); assert.equal(preview.prevented, true); assert.equal(previews.length, 1);
 win.navigator = {...win.navigator, standalone: false};
 const desktop = event(href + "?download=1"); context.onClick(desktop); assert.equal(desktop.prevented, false);
 for (const userAgent of ["Android", "iPhone"]) {
  win.navigator = {...win.navigator, userAgent, standalone: true};
  const pwa = event(href + "?download=1"); context.onClick(pwa); assert.equal(pwa.prevented, true);
 }
 assert.equal(intercepted.length, 3); assert.equal(previews.length, 1);
});

test("share preparation preserves original binary bytes/name and authenticated URL; share happens only on second tap", async t => {
 const calls = fetchFile();
 const shares = [];
 win.navigator = {...win.navigator, userAgent: "iPhone", standalone: true, canShare: data => data.files[0].name === "原图.png", share(data) { shares.push(data); return Promise.resolve(); }};
 const root = mount(t); start(); await tick();
 assert.deepEqual(calls.map(call => call.url), [identity.metadataUrl, identity.downloadUrl]);
 assert.ok(calls.every(call => call.options.credentials === "same-origin" && call.options.redirect === "error"));
 assert.equal(shares.length, 0);
 const save = control(root, "存储到文件…");
 assert.equal(control(root, "在新窗口打开下载").props.href, identity.downloadUrl);
 assert.equal(control(root, "在新窗口打开下载").props.target, "_blank");
 save.props.onClick(); await tick();
 assert.equal(shares.length, 1); assert.equal(shares[0].files[0].name, "原图.png");
 assert.deepEqual(new Uint8Array(await shares[0].files[0].arrayBuffer()), Uint8Array.of(0, 127, 255, 10));
 assert.match(text(root), /请确认文件已存储/);
});

test("share cancellation is not claimed as saved, and failure remains retryable", async t => {
 fetchFile();
 win.navigator = {...win.navigator, share: () => Promise.reject(new DOMException("Cancelled", "AbortError"))};
 const root = mount(t); start(); await tick(); control(root, "存储到文件…").props.onClick(); await tick();
 assert.match(text(root), /已取消/); assert.ok(control(root, "存储到文件…"));
 win.navigator = {...win.navigator, share: () => Promise.reject(new Error("failed"))};
 control(root, "存储到文件…").props.onClick(); await tick(); assert.match(text(root), /无法打开系统分享面板/);
});

test("unsupported share, oversize metadata and failed auth offer honest new-window fallback", async t => {
 const root = mount(t);
 fetchFile(); win.navigator = {...win.navigator, canShare: () => false};
 start(); await tick(); assert.match(text(root), /不支持文件分享/); assert.equal(walk(root).some(n => n.type === "button" && text(n) === "存储到文件…"), false);
 globalThis.fetch = async url => url === identity.metadataUrl ? Response.json({artifact: meta({sizeBytes: SHARE_FILE_LIMIT + 1})}) : assert.fail("oversize must not fetch body");
 start(); await tick(); assert.match(text(root), /超过 20 MB/);
 globalThis.fetch = async () => new Response("unauthorized", {status: 401});
 start(); await tick(); assert.match(text(root), /登录已失效/); assert.ok(control(root, "重试"));
 assert.equal(control(root, "在新窗口打开下载").props.rel, "noopener noreferrer");
});

test("missing share capability never fetches file bytes, and changing conversation discards prepared file", async t => {
 const calls = fetchFile();
 win.navigator = {...win.navigator, share: undefined};
 const root = mount(t); start(); await tick();
 assert.deepEqual(calls.map(call => call.url), [identity.metadataUrl]);
 assert.match(text(root), /不支持文件分享/);
 navigationKey.value = "conversation-b"; await nextTick();
 assert.equal(walk(root).some(n => n.type === "section"), false);
 navigationKey.value = "conversation-a";
});

test("bounded response rejects oversized headers and unadvertised bodies without building a File", async () => {
 let cancelled = false;
 const oversizedHeader = () => ({ok: true, headers: new Headers({"content-length": String(SHARE_FILE_LIMIT + 1)}), body: {cancel: async () => { cancelled = true; }}});
 assert.equal(await readShareFile(identity, meta(), {fetcher: oversizedHeader}), null); assert.equal(cancelled, true);
 let fetched = false;
 assert.equal(await readShareFile(identity, meta({sizeBytes: SHARE_FILE_LIMIT + 1}), {fetcher: () => { fetched = true; }}), null); assert.equal(fetched, false);
 const response = new Response(new Uint8Array(SHARE_FILE_LIMIT + 1));
 assert.equal(await readShareFile(identity, meta(), {fetcher: () => response}), null);
 assert.equal(response.body.locked, false);
});

test("closing before a pending metadata response aborts preparation and never opens share", async t => {
 let release;
 globalThis.fetch = async () => new Promise(resolve => { release = resolve; });
 const root = mount(t); start(); await tick(); control(root, "关闭").props.onClick(); await tick();
 release(Response.json({artifact: meta()})); await tick(); assert.equal(walk(root).some(n => n.type === "section"), false);
});

test("Android PWA prepares with progress, shares original file only on a fresh tap, and never claims saved", async t => {
 const shares = [], calls = [];
 let stream;
 win.navigator = {...win.navigator, userAgent:"Android", standalone:true, canShare:()=>true, share(data) { shares.push(data); return Promise.resolve(); }};
 globalThis.fetch = async (url, options) => {
  calls.push({url, options});
  return url === identity.metadataUrl ? Response.json({artifact:meta()}) : new Response(new ReadableStream({start(controller) { stream=controller; }}));
 };
 const root=mount(t), click=clickEvent();
 assert.equal(onArtifactDownload(click,identity),true); await tick();
 assert.match(text(root),/正在准备原文件/);
 assert.equal(walk(root).some(n=>n.type==='button' && text(n)==='保存/分享…'),false);
 stream.enqueue(Uint8Array.of(0,127)); await tick(); assert.match(text(root),/50%/);
 stream.enqueue(Uint8Array.of(255,10)); stream.close(); await tick();
 assert.match(text(root),/取决于已安装的应用/); assert.equal(shares.length,0);
 const save=control(root,'保存/分享…'); save.props.onClick();
 assert.equal(shares.length,1,'navigator.share is called synchronously in the new button click'); await tick();
 assert.equal(shares[0].files[0].name,'原图.png');
 assert.deepEqual(new Uint8Array(await shares[0].files[0].arrayBuffer()),Uint8Array.of(0,127,255,10));
 assert.match(text(root),/无法确认保存结果/); assert.doesNotMatch(text(root),/已保存|保存成功|存储到文件/);
 win.navigator.share=()=>Promise.reject(new DOMException('Cancelled','AbortError'));
 save.props.onClick(); await tick(); assert.match(text(root),/已取消/);
 assert.equal(control(root,'保存/分享…').props.disabled,false);
 const direct=control(root,'直接下载');
 assert.equal(direct.props.href,identity.downloadUrl); assert.equal(direct.props.download,''); assert.equal(direct.props.target,undefined);
 direct.props.onClick(); await tick(); assert.match(text(root),/网页无法确认是否保存成功/);
 assert.deepEqual(calls.map(call=>call.url),[identity.metadataUrl,identity.downloadUrl],'fallback link does not script another request or recursively open the panel');
});

test("Android PWA offers direct download for unsupported or large files, and an actionable retry after failure", async t => {
 win.navigator={...win.navigator,userAgent:'Android',standalone:true,share:()=>Promise.resolve(),canShare:()=>false};
 fetchFile(); const root=mount(t); start(); await tick();
 assert.match(text(root),/不支持文件分享/); assert.ok(control(root,'直接下载'));
 globalThis.fetch=async url=>url===identity.metadataUrl ? Response.json({artifact:meta({sizeBytes:SHARE_FILE_LIMIT+1})}) : assert.fail('oversize must not fetch body');
 start(); await tick(); assert.match(text(root),/超过 20 MB/); assert.ok(control(root,'直接下载'));
 globalThis.fetch=async()=>new Response('unauthorized',{status:401});
 start(); await tick(); assert.match(text(root),/登录已失效/);
 fetchFile(); win.navigator.canShare=()=>true;
 control(root,'重试').props.onClick(); await tick(); assert.ok(control(root,'保存/分享…'));
 win.navigator.share=()=>Promise.reject(new Error('denied'));
 control(root,'保存/分享…').props.onClick(); await tick(); assert.match(text(root),/无法打开系统分享面板/);
 assert.ok(control(root,'保存/分享…')); assert.ok(control(root,'直接下载'));
});

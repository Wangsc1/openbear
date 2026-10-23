import {useRecentConversationRows} from './components/conversationRecentRows.js';
import {normalizePromptPolicy, promptPolicyFlags} from './components/promptPolicy.js';
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {computed, nextTick, reactive, ref} from "vue";
import {parse} from "@vue/compiler-sfc";
import {isActivityWaiting, pendingConversationRows, pendingFolderCounts, folderActivityCounts, activityInteractionTarget, activityLabel, activityState, activityReadRequests, applyActivityReadVersions, createActivityReadTracker, eligibleActivityRead, groupActivityItems, withActivityReadVersion} from "./conversationActivity.js";
import {acceptActivityReadReceipt, applyCatalogPacket, referenceCatalog, stopReferenceCatalog} from "./references/catalog.js";
import {treeItemId as rowId, treeItemParent, compareTreeItems, resolveTreeDrop} from "./components/conversationTreeInteractions.js";
import * as conversationGroupsTree from "./components/conversationGroupsTree.js";
const read = file => fs.readFileSync(new URL(file, import.meta.url), "utf8");
const row = (id, extra = {}) => ({conversationUuid: id, kind: "conversation", title: id, folderId: "original-folder", activityVersion: 1, activityReadVersion: 0, activityUnread: true, activityState: "completed", running: false, activityAtMs: 10, activityResult: {opId: "run:" + id, opRevision: 2, status: "completed"}, ...extra});
const snapshot = () => ({item: row("a"), conversationUuid: "a", loadedConversationUuid: "a", visible: true, focused: true, ready: true, atLatest: true, running: false, operation: {opId: "run:a", revision: 2}});

test("waiting types and targets remain actionable after reading, sort ahead of errors and clear only with live state", () => {
  const waiting = row("b", {running: true, activityState: "waiting", activityAtMs: 1, activityPending: [{interactionId: "form-b", action: "questionnaire"}]});
  for (const [action, label] of Object.entries({confirm: "待确认", select: "待选择", prompt: "待填写", questionnaire: "待填写问卷"})) {
    assert.equal(activityLabel({...waiting, activityPending: [{interactionId: "form-b", action}]}), label);
  }
  const read = withActivityReadVersion(waiting, 1);
  assert.equal(read.activityUnread, false);
  assert.equal(activityLabel(read), "待填写问卷");
  assert.deepEqual(activityInteractionTarget(read), {conversationUuid: "b", interactionId: "form-b"});
  const groups = groupActivityItems([row("error", {activityState: "failed", activityAtMs: 100}), read]);
  assert.deepEqual(groups[0].items.map(item => item.conversationUuid), ["b", "error"]);
  assert.equal(activityLabel({...read, activityPending: [...read.activityPending, {interactionId: "form-c", action: "confirm"}]}), "待填写问卷 · 2项");
  assert.equal(activityInteractionTarget({...read, activityState: "running", activityPending: []}), null);
  assert.equal(activityInteractionTarget(row("completed")), null);
});

test("read receipts cannot resurrect unread through delayed packets or consume a newer completion", () => {
  const versions = new Map([["a", 2]]);
  const status = {items: [row("run", {running: true})], activityItems: [row("a"), row("run", {running: true})]};
  assert.deepEqual(applyActivityReadVersions(status, versions).activityItems.map(item => item.conversationUuid), ["run"]);
  assert.equal(withActivityReadVersion(row("a", {activityVersion: 3}), 2).activityUnread, true);
  assert.deepEqual(activityReadRequests([row("a", {activityVersion: 3}), row("read", {activityUnread: false})]), [{conversationUuid: "a", version: 3}]);
  assert.equal(status.activityItems.length, 2);
});

test("global receipt is cross-component and persists against stale WebSocket status but clears on logout", () => {
  stopReferenceCatalog({clear: true});
  applyCatalogPacket({type: "snapshot", epoch: "e", seq: 1, items: [], treeStatus: {items: [], activityItems: [row("a")]}});
  acceptActivityReadReceipt({items: [{conversationUuid: "a", activityReadVersion: 1}]});
  assert.equal(referenceCatalog.treeStatus.activityItems.length, 0);
  applyCatalogPacket({type: "patch", epoch: "e", previousSeq: 1, seq: 2, treeStatus: {items: [], activityItems: [row("a")]}});
  assert.equal(referenceCatalog.treeStatus.activityItems.length, 0);
  applyCatalogPacket({type: "patch", epoch: "e", previousSeq: 2, seq: 3, treeStatus: {items: [], activityItems: [row("a", {activityVersion: 2})]}});
  assert.equal(referenceCatalog.treeStatus.activityItems.length, 1);
  stopReferenceCatalog({clear: true});
  assert.equal(referenceCatalog.activityReadVersions.size, 0);
});

test("auto read requires actual visible/focused latest result with exact conversation and terminal revision", () => {
  assert.deepEqual(eligibleActivityRead(snapshot()), {conversationUuid: "a", version: 1});
  for (const change of [
    {visible: false}, {focused: false}, {ready: false}, {atLatest: false}, {running: true},
    {loadedConversationUuid: "previous"}, {conversationUuid: "other"}, {operation: undefined},
    {operation: {opId: "run:a", revision: 1}}, {operation: {opId: "other", revision: 2}},
    {item: row("a", {running: true})}, {item: row("a", {activityUnread: false})},
  ]) assert.equal(eligibleActivityRead({...snapshot(), ...change}), null, JSON.stringify(change));
});

function trackerHarness({send} = {}) {
  let current = snapshot(), pending = null, serial = 0;
  const calls = [], receipts = [];
  const tracker = createActivityReadTracker({snapshot: () => current,
    send: async items => { calls.push(items); return send ? send(items) : {items: [{conversationUuid: "a", activityReadVersion: items[0].version}]}; },
    accepted: receipt => receipts.push(receipt), setTimer(fn) { pending = {id: ++serial, fn}; return serial; },
    clearTimer(id) { if (pending?.id === id) pending = null; },
  });
  return {tracker, calls, receipts, set: value => {current = value;}, tick: async () => {const fn = pending?.fn; pending = null; if (fn) await fn();}, hasTimer: () => Boolean(pending)};
}

test("switching/backgrounding during dwell cancels read and opening again acknowledges once", async () => {
  const h = trackerHarness();
  h.tracker.schedule(); h.set({...snapshot(), focused: false}); await h.tick();
  assert.equal(h.calls.length, 0);
  h.set(snapshot()); h.tracker.schedule(); await h.tick();
  assert.deepEqual(h.calls, [[{conversationUuid: "a", version: 1}]]);
  h.tracker.schedule(); await h.tick(); assert.equal(h.calls.length, 1);
  h.tracker.dispose();
});

test("new completion arriving during read HTTP remains eligible and uses a fresh version", async () => {
  let resolve;
  const h = trackerHarness({send: items => items[0].version === 1 ? new Promise(r => {resolve = r;}) : Promise.resolve({items: []})});
  h.tracker.schedule(); const pending = h.tick();
  h.set({...snapshot(), item: row("a", {activityVersion: 2})});
  resolve({items: [{conversationUuid: "a", activityReadVersion: 1}]}); await pending;
  await h.tick();
  assert.deepEqual(h.calls.map(items => items[0].version), [1, 2]);
  h.tracker.dispose();
});

test("failed HTTP never consumes a completion and unmount clears the pending retry", async () => {
  const h = trackerHarness({send: async () => {throw Error("offline");}});
  h.tracker.schedule(); await h.tick();
  assert.equal(h.receipts.length, 0); assert.equal(h.hasTimer(), true);
  h.tracker.dispose(); await h.tick(); assert.equal(h.calls.length, 1);
});

test("real tree alias opens the same row without moving/expanding folders; stale read cannot clear a new completion", async () => {
  const source = parse(read("./components/ConversationTree.vue")).descriptor.scriptSetup.content.replace(/^import[\s\S]*?;\n/gm, "");
  const emitted = [], sent = [];
  let resolve;
  const catalog = {connected: false, ready: false, activityReadVersions: new Map()};
  const ctx = vm.createContext({...conversationGroupsTree, normalizePromptPolicy, promptPolicyFlags, useRecentConversationRows, computed, nextTick, reactive, ref, rowId, treeItemParent, compareTreeItems, resolveTreeDrop, activityLabel, activityState, activityReadRequests, isActivityWaiting, pendingConversationRows, pendingFolderCounts, folderActivityCounts,
    // UI import seam only; alias navigation and read-receipt behavior remain real.
    defineLazyView: () => ({}),
    clearTimeout, defineProps: () => ({activeConversationUuid: "", draftConversation: null}), defineEmits: () => (...args) => emitted.push(args), defineExpose() {},
    watch() {}, onMounted() {}, onBeforeUnmount() {}, referenceCatalog: catalog,
    acceptActivityReadReceipt(receipt) {catalog.activityReadVersions = new Map(receipt.items.map(item => [item.conversationUuid, item.activityReadVersion]));},
    Api: {readConversationActivity: items => {sent.push(items); return new Promise(r => {resolve = r;});}}, apiError: String, ElMessage: {error(error) {throw Error(error);}},
  });
  vm.runInContext(source, ctx);
  ctx.initial = {items: [], activityItems: [row("a")]};
  vm.runInContext("selectedFolderId.value = 'keep-selected'; applyStatus(initial); openActivityConversation(activityItems.value[0])", ctx);
  const opened = emitted.find(item => item[0] === "open");
  assert.equal(opened[1].conversationUuid, "a");
  assert.equal(vm.runInContext("selectedFolderId.value", ctx), "keep-selected");
  assert.equal(vm.runInContext("expanded.value.size", ctx), 0);
  assert.equal(vm.runInContext("stateFor('original-folder').items[0].activityUnread", ctx), true);
  const pending = vm.runInContext("markActivityRead(activityItems.value)", ctx);
  ctx.newer = {items: [], activityItems: [row("a", {activityVersion: 2})]};
  vm.runInContext("applyStatus(newer)", ctx);
  resolve({items: [{conversationUuid: "a", activityReadVersion: 1}]}); await pending;
  assert.equal(sent[0][0].version, 1);
  assert.equal(vm.runInContext("activityItems.value[0].activityUnread", ctx), true);
  assert.equal(vm.runInContext("stateFor('original-folder').items[0].activityUnread", ctx), true);
});

test("ConsoleView snapshot rejects stale global status until matching rendered operation is in the focused viewport", () => {
  const source = read("./views/consoleView/ConsoleView.vue");
  const code = source.slice(source.indexOf("function activityReadSnapshot()"), source.indexOf("function scheduleActivityRead()"));
  const ctx = vm.createContext({withActivityReadVersion, props: {navigationObscured: false}, window: {matchMedia: () => ({matches: true})}, activeConversationUuid: ref("a"), referenceCatalog: {treeStatus: {activityItems: [row("a")]}, activityReadVersions: new Map()},
    chatState: ref({conversationUuid: "a"}), scroller: ref({clientHeight: 500}), scrollerDistanceFromBottom: () => 0,
    document: {visibilityState: "visible", hasFocus: () => true}, componentMounted: true, loading: ref(false), streamFlushPending: false,
    turns: ref([{stats: {live: false}}]), running: ref(false), sendPending: ref(false), operationsById: ref(new Map()),
  });
  vm.runInContext(code, ctx);
  assert.equal(eligibleActivityRead(vm.runInContext("activityReadSnapshot()", ctx)), null);
  ctx.operationsById.value.set("run:a", {opId: "run:a", revision: 2});
  assert.deepEqual(eligibleActivityRead(vm.runInContext("activityReadSnapshot()", ctx)), {conversationUuid: "a", version: 1});
  ctx.streamFlushPending = true; assert.equal(eligibleActivityRead(vm.runInContext("activityReadSnapshot()", ctx)), null);
  ctx.streamFlushPending = false;
  ctx.props.navigationObscured = true;
  for (const width of [320, 375, 414, 760, 768, 1024]) {
    ctx.window.matchMedia = query => {assert.equal(query, "(max-width: 760px)"); return {matches: width <= 760};};
    assert.equal(Boolean(eligibleActivityRead(vm.runInContext("activityReadSnapshot()", ctx))), width > 760, `drawer occlusion at ${width}px`);
  }
  ctx.window.matchMedia = () => ({matches: true});
  ctx.props.navigationObscured = false;
  assert.ok(eligibleActivityRead(vm.runInContext("activityReadSnapshot()", ctx)), "closing phone drawer permits viewing again");
  assert.match(read("./App.vue"), /:navigation-obscured="sidebarOpen \|\| pendingConversationsOpen"/);
  assert.match(source, /watch\(\(\) => \[props\.conversationUuid, props\.navigationObscured/);
  assert.match(source, /window\.addEventListener\("resize", scheduleActivityRead\)/);
  assert.match(source, /window\.removeEventListener\("resize", scheduleActivityRead\)/);
  assert.match(source, /activityReadTracker\?\.dispose\(\)/);
});

test("collapsed directories count running and unread descendants by folder path; waiting counts only as waiting", () => {
  const counts = folderActivityCounts([
    row("done", {folderId: "c", folderPath: ["a", "b", "c"]}),
    row("busy", {folderId: "b", folderPath: ["a", "b"], running: true, activityState: "running"}),
    row("ask", {folderId: "c", folderPath: ["a", "b", "c"], running: true, activityState: "waiting", activityPending: [{action: "confirm"}]}),
    row("temp", {folderId: "", folderPath: []}),
    row("seen", {folderId: "c", folderPath: ["a", "b", "c"], activityUnread: false}),
    row("gone", {folderId: "c", folderPath: ["a", "b", "c"], archived: true}),
    row("busy", {folderId: "b", folderPath: ["a", "b"], running: true, activityState: "running"}),
  ]);
  assert.deepEqual(counts, {
    a: {running: 1, unread: 1}, b: {running: 1, unread: 1}, c: {running: 0, unread: 1}, __temporary: {running: 0, unread: 1},
  });
});

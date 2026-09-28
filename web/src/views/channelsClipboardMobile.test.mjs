import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {parse, compileScript, compileStyle, compileTemplate} from "@vue/compiler-sfc";
import {baseParse} from "@vue/compiler-dom";
import postcss from "postcss";

const source = readFileSync(new URL("./ChannelsView.vue", import.meta.url), "utf8");
const {descriptor, errors} = parse(source, {filename: "ChannelsView.vue"});
assert.deepEqual(errors, []);
const between = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from) + from.length));
const clipboardHandlers = between("async function copyModelMetadata(row) {", "function payloadWithMetadataForRow(")
  + between("async function pasteModelMetadata() {", "async function loadModelsDevProviders()");
const walk = list => (list || []).flatMap(node => [node, ...walk(node.children)]);

function clipboardHarness({writeThrows = true, copied = true, readable = ""} = {}) {
  const calls = [], messages = [], applied = [];
  const context = vm.createContext({
    copiedModelMetadata: {value: null}, copiedModelMetadataSource: {value: ""},
    metadataFromModel: row => ({version: 2, metadata: {contextWindow: row.contextWindow}}),
    MODEL_METADATA_CLIPBOARD_KEY: "test-key",
    localStorage: {setItem() {if (writeThrows) throw new DOMException("denied", "SecurityError"); calls.push("store");},
      getItem() {if (writeThrows) throw new DOMException("denied", "SecurityError"); calls.push("read-store"); return "";}},
    navigator: {clipboard: {readText: async () => {if (readable === null) throw new DOMException("denied", "NotAllowedError"); return readable;}}},
    copyTextToClipboard: async text => {calls.push(["clipboard", text]); return copied;},
    applyModelMetadata: value => applied.push(value),
    ElMessage: {success: value => messages.push(["success", value]), warning: value => messages.push(["warning", value]), error: value => messages.push(["error", value])},
  });
  vm.runInContext(clipboardHandlers, context);
  return {context, calls, messages, applied};
}

test("restricted localStorage does not preempt system copy and in-memory paste remains available", async () => {
  const h = clipboardHarness({writeThrows: true, readable: null});
  await h.context.copyModelMetadata({fullname: "channel/model", contextWindow: 12345});
  assert.deepEqual(h.calls.map(call => Array.isArray(call) ? call[0] : call), ["clipboard"]);
  assert.equal(h.messages[0][0], "success");
  await h.context.pasteModelMetadata();
  assert.equal(h.applied[0].metadata.contextWindow, 12345);
  assert.equal(h.messages.at(-1)[0], "success");
});

test("blocked clipboard and storage report memory-only state, missing memory gives feedback", async () => {
  const h = clipboardHarness({writeThrows: true, copied: false, readable: null});
  await h.context.copyModelMetadata({fullname: "channel/model", contextWindow: 40});
  assert.match(h.messages[0][1], /仅在当前页面可用/);
  await h.context.pasteModelMetadata();
  assert.equal(h.applied.length, 1);
  h.context.copiedModelMetadata.value = null;
  await h.context.pasteModelMetadata();
  assert.match(h.messages.at(-1)[1], /没有可粘贴/);
});

test("four channel dialogs teleport and keep a separate bounded scroll body and footer only on phones", () => {
  const script = compileScript(descriptor, {id: "channel-test"});
  assert.deepEqual(compileTemplate({source: descriptor.template.content, filename: "ChannelsView.vue", id: "channel-test", compilerOptions: {bindingMetadata: script.bindings}}).errors, []);
  const dialogs = walk(baseParse(descriptor.template.content).children).filter(n => n.tag === "el-dialog");
  assert.equal(dialogs.length, 4);
  for (const n of dialogs) {
    assert.ok(n.props.some(p => p.name === "append-to-body"));
    assert.match(n.props.find(p => p.name === "class").value.content, /channels-dialog mac-dialog admin-dialog/);
    assert.ok(n.children.some(child => child.type === 1 && child.tag === "template" && child.props.some(p => p.name === "slot" && p.arg?.content === "footer")));
  }
  const compiled = descriptor.styles.map((style, index) => {
    const result = compileStyle({source: style.content, id: "data-v-channel-test", filename: "ChannelsView.vue", scoped: style.scoped});
    assert.deepEqual(result.errors, [], `style ${index}`);
    return result.code;
  }).join("\n");
  const css = postcss.parse(compiled), phoneRules = [], desktopRules = [];
  css.walkRules(rule => {
    const conditions = []; for (let parent = rule.parent; parent; parent = parent.parent) if (parent.type === "atrule" && parent.name === "media") conditions.push(parent.params);
    if (conditions.some(condition => /max-width:\s*760px/.test(condition))) phoneRules.push(rule);
    else desktopRules.push(rule);
  });
  const find = (rules, selector) => rules.find(rule => rule.selectors.includes(selector));
  assert.match(find(phoneRules, ".channels-dialog.mac-dialog.admin-dialog.el-dialog").toString(), /--mobile-viewport-height/);
  assert.match(find(phoneRules, ".channels-dialog.mac-dialog.admin-dialog .el-dialog__body").toString(), /overflow-y:\s*auto/);
  assert.match(find(phoneRules, ".channels-dialog.mac-dialog.admin-dialog .el-dialog__footer").toString(), /flex:\s*none/);
  for (const target of ["header", "body", "footer"]) {
    const rule = find(phoneRules, `.channels-dialog.mac-dialog.admin-dialog .el-dialog__${target}`);
    assert.ok(rule, target);
    assert.ok(!rule.nodes.some(d => ["padding", "padding-left", "padding-right", "padding-inline"].includes(d.prop)), `${target}: common admin safe-area side padding must remain authoritative`);
  }
  const shared = readFileSync(new URL("../admin-mobile.css", import.meta.url), "utf8");
  for (const target of ["header", "body", "footer"]) assert.match(shared, new RegExp(`\\.admin-dialog \\.el-dialog__${target}[^}]*safe-area-inset-(?:left|right)`));
  assert.match(phoneRules.find(rule => rule.selector.startsWith(".batch-dialog-header["))?.toString() || "", /safe-area-inset-left/);
  assert.ok(!find(desktopRules, ".channels-dialog.mac-dialog.admin-dialog.el-dialog"), "mobile geometry must not affect desktop");
  assert.ok(find(desktopRules, ".channels-dialog.mac-dialog.el-dialog"), "teleported desktop dialog retains its compact appearance");
  assert.ok(!compiled.includes(".mac-dialog.admin-dialog.el-dialog" + "[data-v-channel-test]"), "teleported root is selected globally");
});

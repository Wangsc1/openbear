import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {parse, compileScript, compileStyle, compileTemplate} from "@vue/compiler-sfc";
import postcss from "postcss";
import {copyTextToClipboard} from "../utils/clipboard.js";

const source = readFileSync(new URL("./ArtifactPreview.vue", import.meta.url), "utf8");
const {descriptor} = parse(source, {filename: "ArtifactPreview.vue"});

test("artifact code copy invokes the shared clipboard fallback from its real click handler", async () => {
  const code = source.slice(source.indexOf("async function onContentClick(event) {"), source.indexOf("function mediaChanged()"));
  const copied = [], button = {textContent: "复制", isConnected: false};
  button.closest = selector => selector === ".md-code-block" ? {querySelector: () => ({textContent: "exact source"})} : null;
  let prevented = 0;
  const context = vm.createContext({copyTextToClipboard: async text => {copied.push(text); return true;}, setTimeout() {}});
  vm.runInContext(code, context);
  await context.onContentClick({target: {closest: () => button}, preventDefault() {prevented++;}, stopPropagation() {prevented++;}});
  assert.deepEqual(copied, ["exact source"]);
  assert.equal(button.textContent, "已复制");
  assert.equal(prevented, 2);
  assert.match(descriptor.scriptSetup.content, /import \{copyTextToClipboard\} from "\.\.\/utils\/clipboard\.js"/);
});

test("shared clipboard utility attempts legacy copy when modern API is absent", async () => {
  const previousDocument = globalThis.document;
  const navigatorProperty = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const area = {style: {}, value: "", setAttribute() {}, focus() {}, select() {}, setSelectionRange() {}, remove() {}};
  let invoked = 0;
  try {
    globalThis.document = {activeElement: null, body: {appendChild(node) {assert.equal(node, area);}}, createElement: () => area,
      execCommand(command) {assert.equal(command, "copy"); invoked++; return true;}};
    Object.defineProperty(globalThis, "navigator", {configurable: true, value: {}});
    assert.equal(await copyTextToClipboard("original bytes"), true);
    assert.equal(area.value, "original bytes");
    assert.equal(invoked, 1);
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (navigatorProperty) Object.defineProperty(globalThis, "navigator", navigatorProperty);
    else delete globalThis.navigator;
  }
});

test("phone fullscreen preview stays inside the visual viewport with safe top/sides and existing bottom footer", () => {
  const script = compileScript(descriptor, {id: "preview-mobile"});
  assert.deepEqual(compileTemplate({source: descriptor.template.content, filename: "ArtifactPreview.vue", id: "preview-mobile", compilerOptions: {bindingMetadata: script.bindings}}).errors, []);
  const style = compileStyle({source: descriptor.styles[0].content, id: "preview-mobile", filename: "ArtifactPreview.vue", scoped: false});
  assert.deepEqual(style.errors, []);
  const css = postcss.parse(style.code), rules = [];
  css.walkRules(rule => {
    let phone = false;
    for (let parent = rule.parent; parent; parent = parent.parent) if (parent.type === "atrule" && /max-width:\s*760px/.test(parent.params)) phone = true;
    rules.push({rule, phone});
  });
  const get = (selector, phone) => rules.find(entry => entry.phone === phone && entry.rule.selectors.includes(selector))?.rule.toString() || "";
  const root = get(".artifact-preview-dialog.el-dialog.is-fullscreen", true);
  assert.match(root, /--mobile-viewport-top/);
  assert.match(root, /--mobile-viewport-height/);
  assert.match(root, /safe-area-inset-top/);
  for (const selector of [".artifact-preview-header", ".artifact-preview-toolbar", ".artifact-preview-footer"]) {
    assert.match(get(selector, true), /safe-area-inset-left/);
    assert.match(get(selector, true), /safe-area-inset-right/);
  }
  assert.match(get(".artifact-preview-body", true), /safe-area-inset-left/);
  assert.match(get(".artifact-preview-footer", true), /safe-area-inset-bottom/);
  assert.match(get(".artifact-preview-dialog.el-dialog.is-fullscreen", false), /height:\s*100dvh/);
  assert.match(source, /<ArtifactDownload :navigation-key="navigationKey"\/>/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';

const source = fs.readFileSync(new URL('./ConversationTree.vue', import.meta.url), 'utf8');
const conversation = fs.readFileSync(new URL('./ConversationPropertiesDialog.vue', import.meta.url), 'utf8');
const style = fs.readFileSync(new URL('./conversationTreeProperties.css', import.meta.url), 'utf8');

test('folder prompt editor is not wrapped in a native label that activates Monaco hidden IME input', () => {
  const labels = [...source.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)];
  assert.ok(labels.length > 0);
  assert.ok(labels.every(([label]) => !label.includes('<MdEditor') && !label.includes('<AdaptiveMdEditor')));
  assert.match(source, /<PromptPolicyEditor v-model="folderPromptPolicy"/);
  const policy = fs.readFileSync(new URL('./PromptPolicyEditor.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(policy, /<label\b/);
  assert.match(policy, /class="folder-prompt-editor"/);
});

test('folder properties use a compact single-line header, centered tabs and only the requested context controls', () => {
  assert.match(style, /el-dialog__header \{[^}]*display:grid;[^}]*grid-template-columns:minmax\(0,1fr\) auto minmax\(0,1fr\)/);
  assert.match(style, /folder-properties-heading h2 \{[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap/);
  assert.match(source, /<h2 :title="propertiesForm.path">/);
  assert.match(source, />默认模型<\/button>/);
  assert.doesNotMatch(source, /effective-disclosure|effective-line|查看当前继承提示词/);
  assert.match(style, /grid-template-columns:70px minmax\(0,1fr\) minmax\(0,1fr\)/);
  postcss.parse(style).walkRules(rule => {
    assert.ok(rule.selectors.every(selector => /^(html\.dark )?\.folder-properties-(dialog|popover)/.test(selector)), rule.selector);
  });
  assert.match(style, /\.folder-properties-dialog \.el-dialog__body \{[^}]*min-height:0;[^}]*overflow:auto;/);
  assert.match(source, /class="property-segmented" role="tablist"/);
  assert.match(source, /aria-controls="folder-properties-panel-context"/);
  assert.match(source, /aria-controls="folder-properties-panel-defaults"/);
});

test('temporary properties are separated at the bottom of the system menu', () => {
  const menu = source.slice(source.indexOf(`<template v-else-if="['system', 'root'].includes(menu.row?.kind)">`), source.indexOf('<template v-else>', source.indexOf(`<template v-else-if="['system', 'root'].includes(menu.row?.kind)">`)));
  assert.ok(menu.indexOf("runMenuAction('new-conversation')") < menu.indexOf("runMenuAction('new-folder')"));
  assert.match(menu, /新建根级目录[\s\S]*<template v-if="menu\.row\?\.systemNode === 'temporary'">\s*<hr \/>\s*<button[^>]+runMenuAction\('properties'\)/);
});

test('ordinary workspace input keeps its label and a neutral public example', () => {
  assert.match(source, /<label\b[^>]*>\s*<span id="folder-workspace-label">本节点工作目录[\s\S]*?<el-input[^>]+placeholder="例如 \/home\/user\/projects\/my-project"[^>]*\/>\s*<\/label>/);
});

test('conversation properties precedes the final delete action like folder properties, preserving prompt management', () => {
  const menu = source.slice(source.indexOf("runMenuAction('new-sibling')"),source.indexOf('<ConversationPromptDialog'));
  const actions = [...menu.matchAll(/runMenuAction\('([^']+)'\)/g)].map(match=>match[1]);
  assert.deepEqual(actions.slice(-3), ['archive','conversation-properties','delete-conversation']);
  assert.match(menu, /runMenuAction\('conversation-properties'\)[\s\S]*?<\/button>\s*<hr\s*\/>\s*<button[^>]*runMenuAction\('delete-conversation'\)/);
  const folderMenu = source.slice(source.indexOf("runMenuAction('new-conversation')"),source.indexOf("<template v-else-if=\"['system', 'root']"));
  const folderActions = [...folderMenu.matchAll(/runMenuAction\('([^']+)'\)/g)].map(match=>match[1]);
  assert.deepEqual(folderActions.slice(-2), ['properties','delete-folder']);
  assert.ok(actions.includes('refresh-prompt'));
  assert.match(source, /<ConversationPromptDialog v-model="promptDialog"/);
  assert.doesNotMatch(conversation, /ConversationPromptDialog|snapshotFrozen|snapshotUpdateRequired/);
});

<script setup>
import {onMounted, onBeforeUnmount, ref, watch} from 'vue';
import * as monaco from 'monaco-editor';
import {isDarkTheme, subscribeTheme} from '../../../theme.js';
import {editorTheme} from '../../../editorTheme.js';
import {bindMobileEditorFontSize} from '../../../mobileInput.js';

const props = defineProps({
  modelValue: {type: String, default: ''}, language: {type: String, default: 'json'},
  readonly: Boolean, label: {type: String, default: '代码编辑'},
  identity: {type: Object, default: () => ({})},
});
const emit = defineEmits(['update:modelValue', 'change']);
const host = ref(null), dirty = ref(false), error = ref('');
let editor, model, subscription, fontSubscription, contentSubscription, blurSubscription, suppress = false, applied = props.modelValue;
const identity = {...props.identity};
function theme() {
  const style = getComputedStyle(document.documentElement);
  const name = isDarkTheme() ? 'openbear-dark' : 'openbear-light';
  monaco.editor.defineTheme(name, editorTheme(isDarkTheme(), key => style.getPropertyValue(key)));
  editor?.updateOptions({theme: name});
  return name;
}
function flush() {
  if (!editor || props.readonly || editor.getValue() === applied) return;
  applied = editor.getValue(); dirty.value = false;
  emit('change', {...identity, value: applied});
}
function outside(event) { if (!host.value?.contains(event.target)) flush(); }
function format() {
  try {
    if (props.language !== 'json' || props.readonly) return;
    const text = JSON.stringify(JSON.parse(editor.getValue()), null, 2);
    editor.executeEdits('format', [{range: model.getFullModelRange(), text}]);
    error.value = ''; editor.focus();
  } catch (e) { error.value = e.message; }
}
onMounted(() => {
  model = monaco.editor.createModel(props.modelValue, props.language);
  editor = monaco.editor.create(host.value, {
    model, theme: theme(), readOnly: props.readonly, ariaLabel: props.label,
    fontSize: 13, lineHeight: 22, fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    automaticLayout: true, minimap: {enabled: false}, wordWrap: 'on',
    scrollBeyondLastLine: false, padding: {top: 12, bottom: 12},
    lineNumbersMinChars: 3, folding: true, showFoldingControls: 'always',
    bracketPairColorization: {enabled: true}, guides: {bracketPairs: true, indentation: true},
    renderLineHighlight: 'gutter', overviewRulerLanes: 0, fixedOverflowWidgets: true,
    quickSuggestions: false, wordBasedSuggestions: 'off', tabSize: 2,
    scrollbar: {alwaysConsumeMouseWheel: false},
  });
  fontSubscription = bindMobileEditorFontSize(editor);
  contentSubscription = editor.onDidChangeModelContent(() => {
    if (suppress) return;
    dirty.value = editor.getValue() !== applied; error.value = '';
    emit('update:modelValue', editor.getValue());
  });
  blurSubscription = editor.onDidBlurEditorWidget(flush);
  subscription = subscribeTheme(theme);
  // Commit before a toolbar click reads the document, not on a delayed debounce.
  document.addEventListener('pointerdown', outside, true);
});
watch(() => props.modelValue, value => {
  if (!editor || value === editor.getValue()) return;
  suppress = true; model.setValue(value); applied = value; dirty.value = false; suppress = false;
});
watch(() => props.language, value => { if (model) monaco.editor.setModelLanguage(model, value); });
watch(() => props.readonly, value => editor?.updateOptions({readOnly: value}));
onBeforeUnmount(() => {
  flush(); document.removeEventListener('pointerdown', outside, true);
  subscription?.(); fontSubscription?.(); contentSubscription?.dispose(); blurSubscription?.dispose(); editor?.dispose(); model?.dispose();
});
defineExpose({flush});
</script>
<template>
  <div class="ce-code-editor">
    <div class="ce-code-tools">
      <span>{{ language === 'json' ? 'JSON' : language === 'markdown' ? 'Markdown' : '文本' }}<small v-if="readonly"> · 只读</small><small v-else-if="dirty"> · 编辑中</small></span>
      <span v-if="error" class="ce-code-error" role="alert">{{ error }}</span>
      <div><button v-if="language === 'json' && !readonly" type="button" @click="format">格式化</button><button type="button" title="Ctrl / ⌘ + F" @click="editor?.getAction('actions.find')?.run()">查找</button><button v-if="language === 'json'" type="button" @click="editor?.getAction('editor.foldAll')?.run()">折叠</button><button v-if="language === 'json'" type="button" @click="editor?.getAction('editor.unfoldAll')?.run()">展开</button></div>
    </div>
    <div ref="host" class="ce-monaco" />
  </div>
</template>
<style scoped>
.ce-code-editor { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; overflow: hidden; border: 1px solid var(--ob-chat-border); border-radius: 8px; background: var(--ob-chat-panel); }
.ce-code-tools { display: flex; align-items: center; justify-content: space-between; flex: none; gap: 10px; padding: 5px 10px; min-height: 32px; border-bottom: 1px solid var(--ob-chat-line); font: 11px/1.6 inherit; color: var(--ob-chat-subtle); }
.ce-code-tools>div { display: flex; gap: 10px; flex: none; }
.ce-code-tools button { border: 0; border-radius: 3px; padding: 1px 2px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.ce-code-tools button:hover { color: var(--ob-chat-text); background: var(--ob-chat-hover); }
.ce-code-tools button:focus-visible { outline: 2px solid var(--ob-focus); }
.ce-code-error { color: var(--ob-danger); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ce-monaco { flex: 1; min-height: 0; min-width: 0; }
</style>

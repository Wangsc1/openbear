// App 内嵌代码编辑器（打包成单个 HTML，放在 WebView 里）：Monaco + 与 Web 相同的补全规则和配色。
//
// RN -> 编辑器（window.openbearEditor.receive / postMessage）：
//   {type:'init', value, language, readOnly, dark, fontSize, completionMode, completionRoots, refData, mode}
//   {type:'setValue', value} {type:'setTheme', dark} {type:'setOptions', readOnly?, fontSize?, completionMode?, refData?, completionRoots?}
//   {type:'format'} {type:'focus'} {type:'blur'} {type:'insert', text}
// 编辑器 -> RN（ReactNativeWebView.postMessage）：
//   {type:'ready'} {type:'change', value, version} {type:'blur', value} {type:'focus'}
//   {type:'formatError', message} {type:'height', height}
//
// mode: 'markdown' 对应 Web 的 MdEditor（记忆/模板补全）；'code' 对应上下文编辑器的 CodeEditor（JSON 等，行号、折叠）。
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js';
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker&inline';

import { editorTheme } from '@web/editorTheme.js';
import { registerCompletion } from './completion.js';
import { THEME_CHANNELS } from './themeChannels.js';

// JSON 语言自己创建 worker（构建时已改成内联，见 vite.config.mjs），这里只提供编辑器基础 worker
self.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

const post = (message) => window.ReactNativeWebView?.postMessage(JSON.stringify(message));
const host = document.getElementById('editor');
let editor = null;
let state = { mode: 'markdown', completionMode: 'none', completionRoots: null, refData: { mem: [], secret: [], doc: [] }, readOnly: false };
let suppress = false;
let refocusing = false;
let version = 0;

function theme(dark) {
  const channels = THEME_CHANNELS[dark ? 'dark' : 'light'];
  const name = dark ? 'openbear-dark' : 'openbear-light';
  const base = editorTheme(dark, (key) => channels[key] || '');
  // 触屏上补全列表始终是“已聚焦”状态，选中行会用 Monaco 默认的白色前景；配成正文色
  const text = `#${channels['--ob-text-strong-rgb'].split(' ').map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  base.colors = {
    ...base.colors,
    'list.activeSelectionForeground': text,
    'list.focusForeground': text,
    'quickInputList.focusForeground': text,
    'editorSuggestWidget.selectedForeground': text,
    'list.activeSelectionBackground': base.colors['editorSuggestWidget.selectedBackground'],
    'list.focusBackground': base.colors['editorSuggestWidget.selectedBackground'],
  };
  monaco.editor.defineTheme(name, base);
  document.body.style.background = `rgb(${channels['--ob-surface-rgb'].split(' ').join(',')})`;
  return name;
}

function create(init) {
  state = { ...state, ...init };
  const code = init.mode === 'code';
  const model = monaco.editor.createModel(init.value || '', init.language || (code ? 'json' : 'markdown'));
  editor = monaco.editor.create(host, {
    model,
    theme: theme(Boolean(init.dark)),
    readOnly: Boolean(init.readOnly),
    // 手机上 16px 避免 iOS 聚焦放大，与 Web 的 bindMobileEditorFontSize 一致
    fontSize: init.fontSize || 16,
    lineHeight: Math.round((init.fontSize || 16) * 1.6),
    // 与 Web 相同的等宽字体，后面补上中文字体：WKWebView 不会给等宽字体自动回退到中文字形
    fontFamily: "'SF Mono', Menlo, Consolas, 'Roboto Mono', monospace, 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Noto Sans SC', sans-serif",
    automaticLayout: true,
    minimap: { enabled: false },
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    padding: { top: code ? 12 : 10, bottom: code ? 12 : 10 },
    overviewRulerLanes: 0,
    fixedOverflowWidgets: true,
    wordBasedSuggestions: 'off',
    lineNumbers: code ? 'on' : 'off',
    lineNumbersMinChars: 3,
    glyphMargin: false,
    folding: code,
    showFoldingControls: code ? 'always' : 'mouseover',
    renderLineHighlight: code ? 'gutter' : 'none',
    bracketPairColorization: { enabled: code },
    guides: { bracketPairs: code, indentation: code },
    tabSize: 2,
    quickSuggestions: code ? false : { other: true, comments: true, strings: true },
    suggestOnTriggerCharacters: !code,
    suggest: { showWords: false, filterGraceful: true, snippetsPreventQuickSuggestions: false },
    tabCompletion: 'on',
    scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, alwaysConsumeMouseWheel: false },
    contextmenu: false,
    accessibilitySupport: 'off',
    // Android WebView 支持 EditContext，Monaco 默认走它，但点按聚焦不会弹出输入法；用传统 textarea 输入
    editContext: false,
  });
  registerCompletion(monaco, () => state);
  editor.onDidChangeModelContent(() => {
    if (suppress) return;
    version += 1;
    post({ type: 'change', value: editor.getValue(), version });
    if (state.mode !== 'code' && state.completionMode !== 'none') triggerAfterSpecialChar();
  });
  editor.onDidBlurEditorText(() => {
    if (!refocusing) post({ type: 'blur', value: editor.getValue() });
  });
  editor.onDidFocusEditorText(() => {
    if (!refocusing) post({ type: 'focus' });
  });
  post({ type: 'ready' });
}

// Monaco 在 markdown 下 @ / [[ 不总会自动弹补全，与 Web 一样手动触发。
// 手机输入法一次提交整串文字时，内容变化事件里光标还是旧位置，所以等光标更新后再判断。
function triggerAfterSpecialChar() {
  setTimeout(() => {
    const pos = editor.getPosition();
    if (!pos) return;
    const line = editor.getModel().getLineContent(pos.lineNumber);
    const one = line.charAt(pos.column - 2);
    const two = line.slice(Math.max(0, pos.column - 3), pos.column - 1);
    if (one === '@' || one === '＠' || one === '/' || one === '[' || one === '.' || two === '[[') {
      editor.trigger('openbear', 'editor.action.triggerSuggest', {});
    }
  }, 0);
}

function format() {
  try {
    if (state.readOnly || editor.getModel().getLanguageId() !== 'json') return;
    const text = JSON.stringify(JSON.parse(editor.getValue()), null, 2);
    editor.executeEdits('format', [{ range: editor.getModel().getFullModelRange(), text }]);
  } catch (error) {
    post({ type: 'formatError', message: String(error?.message || error) });
  }
}

function receive(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init') {
    if (!editor) create(message);
    return;
  }
  if (!editor) return;
  switch (message.type) {
    case 'setValue':
      if (message.value !== editor.getValue()) {
        // 外部替换内容（加载、撤销草稿等）：用一次编辑替换全文，保留撤销历史，尽量留住光标
        const position = editor.getPosition();
        suppress = true;
        editor.executeEdits('setValue', [{ range: editor.getModel().getFullModelRange(), text: message.value || '' }]);
        suppress = false;
        if (position) editor.setPosition(editor.getModel().validatePosition(position));
      }
      break;
    case 'setTheme':
      monaco.editor.setTheme(theme(Boolean(message.dark)));
      break;
    case 'setOptions': {
      const { readOnly, fontSize, ...rest } = message;
      state = { ...state, ...rest, ...(readOnly === undefined ? {} : { readOnly }) };
      editor.updateOptions({
        ...(readOnly === undefined ? {} : { readOnly }),
        ...(fontSize ? { fontSize, lineHeight: Math.round(fontSize * 1.6) } : {}),
      });
      break;
    }
    case 'format':
      format();
      break;
    case 'focus':
      editor.focus();
      break;
    case 'refocus': {
      // 原生侧刚拿到焦点：让输入框失焦再聚焦，Chromium 会重新请求输入法；光标位置保持不变
      const input = document.activeElement;
      const position = editor.getPosition();
      if (input && typeof input.blur === 'function') {
        refocusing = true;
        input.blur();
        setTimeout(() => {
          editor.focus();
          if (position) editor.setPosition(position);
          refocusing = false;
        }, 30);
      }
      break;
    }
    case 'blur':
      document.activeElement?.blur?.();
      break;
    case 'insert': {
      const selection = editor.getSelection();
      if (selection) editor.executeEdits('insert', [{ range: selection, text: String(message.text || ''), forceMoveMarkers: true }]);
      editor.focus();
      break;
    }
    default:
      break;
  }
}

window.openbearEditor = { receive, get editor() { return editor; }, get state() { return state; }, monaco };
// Android 的 WebView 把 postMessage 投递到 document，iOS 投递到 window
const onMessage = (event) => {
  try {
    receive(typeof event.data === 'string' ? JSON.parse(event.data) : event.data);
  } catch {
    /* 非编辑器消息 */
  }
};
window.addEventListener('message', onMessage);
document.addEventListener('message', onMessage);
post({ type: 'loaded' });

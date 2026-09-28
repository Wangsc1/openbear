// Workers have their own globals: the page's API patches do not reach Monaco.
import './browserCompatibility.js';
import 'monaco-editor/esm/vs/editor/editor.worker.js';

// Monaco worker 配置(Vite ?worker)。兼容补丁之后、编辑器之前 import,
// 保证 window.MonacoEnvironment 在 monaco-editor 模块求值前就绪。
// 不配会报 "Could not create web worker(s)" → worker 退化主线程 → 补全等异步功能失效。
import EditorWorker from "./editor.worker.js?worker";

if (typeof window !== "undefined") {
  window.MonacoEnvironment = {
    getWorker() {
      return new EditorWorker();
    },
  };
}

// 编辑器打包：Monaco 与 Vite 复用 web/ 已安装的依赖，产物是一个自包含 HTML（脚本、样式、worker 全部内联），
// 再写成 src/editor/editorHtml.generated.ts 供 WebView 以 source={{ html }} 离线加载。
//
//   cd mobile && node editor/build.mjs
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '../../web');
const require = createRequire(resolve(web, 'package.json'));
const { defineConfig } = require('vite');

// Monaco 的 JSON 语言模块自己用 new Worker(new URL('json.worker.js', import.meta.url)) 创建 worker，
// 在 WebView 里没有可加载的文件；改成从内联的 worker 模块创建。
function inlineJsonWorker() {
  return {
    name: 'openbear-inline-json-worker',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/monaco-editor/esm/vs/language/json/')) return null;
      const pattern = /new Worker\(\s*new URL\(\s*['"](?:\.\/)?json\.worker(?:\.js)?['"]\s*,\s*import\.meta\.url\s*\)\s*,\s*\{[^}]*\}\s*\)/g;
      if (!code.match(pattern)) return null;
      const prefix = "import __OpenBearJsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker&inline';\n";
      return prefix + code.replace(pattern, 'new __OpenBearJsonWorker()');
    },
  };
}

export default defineConfig({
  root: here,
  logLevel: 'warn',
  plugins: [inlineJsonWorker()],
  resolve: {
    alias: [
      { find: '@web', replacement: resolve(web, 'src') },
      { find: /^monaco-editor\//, replacement: resolve(web, 'node_modules/monaco-editor') + '/' },
    ],
  },
  worker: { format: 'es' },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});

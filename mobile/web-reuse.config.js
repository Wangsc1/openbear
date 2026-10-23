// web/src 复用规则（Metro 打包和 node --test 共用同一份）。
//
// - `@openbear/web/<path>` -> ../web/src/<path>
// - WEB_SHIMS：web/src 中依赖 DOM/Vue/Element Plus/markdown-it 的模块或包 -> mobile 替身
// - 守卫：从 web/src 内部发起的导入，只允许落在 web/src 内的 .js 文件或登记过的替身；
//   未登记的裸导入（npm 包）、.vue、.css 一律报错，防止 Web 专属依赖进入 App。
const path = require('path');

const mobileRoot = __dirname;
const webSrc = path.resolve(mobileRoot, '../web/src');
const shimRoot = path.resolve(mobileRoot, 'src/web-shims');

const nodeModule = (file) => path.join(mobileRoot, 'node_modules', file);

const WEB_SHIMS = {
  // 引用（references/*.js，输入区工作包 B3）：catalog.js 用 vue 的 shallowReactive 做响应式容器、sessionBoundary.js 管浏览器会话；
  // App 用替身（普通对象 + 会话层自己的 WS）。fuse.js / pinyin-pro / markdown-it 是纯 JS 包，按 Web 锁定的版本装在 mobile/，
  // 指向它们的 ESM 入口（Metro 与 node --test 共用）。
  vue: path.join(shimRoot, 'vue.js'),
  [path.join(webSrc, 'sessionBoundary.js')]: path.join(shimRoot, 'sessionBoundary.js'),
  'fuse.js': nodeModule('fuse.js/dist/fuse.mjs'),
  'pinyin-pro': nodeModule('pinyin-pro/dist/index.mjs'),
  'markdown-it': nodeModule('markdown-it/index.mjs'),
  // display.js：Element Plus 图标与 .vue 图标组件仅作为 toolIcon() 的返回值，App 不渲染它们。
  '@element-plus/icons-vue': path.join(shimRoot, 'elementPlusIcons.js'),
  [path.join(webSrc, 'views/consoleView/legacy/ContextCompactionIcon.vue')]: path.join(shimRoot, 'ContextCompactionIcon.js'),
  // markdown.js：顶层创建 markdown-it/katex/highlight.js 渲染器、引用 sessionBoundary(window)/CSS、
  // decodeHtml 依赖 DOM。纯逻辑模块只用到 plainText/answerContent，替身逐行移植这部分。
  [path.join(webSrc, 'views/consoleView/markdown.js')]: path.join(shimRoot, 'markdown.js'),
  // artifactFiles.js（b2）：顶层引用 vue/sessionBoundary/markdown-it；替身逐行保留 artifactFormat 等纯函数。
  [path.join(webSrc, 'artifacts/artifactFiles.js')]: path.join(shimRoot, 'artifactFiles.js'),
};

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 解析一个导入。返回 {filePath} 表示改写到某个文件；返回 {request} 表示交回默认解析器；
 * 违反守卫时抛错。
 */
function resolveWebReuse(moduleName, originPath) {
  let request = moduleName;
  if (request.startsWith('@openbear/web/')) request = path.join(webSrc, request.slice('@openbear/web/'.length));
  const fromWeb = Boolean(originPath) && isInside(webSrc, originPath);
  if (!fromWeb && !request.startsWith(webSrc)) return { request };
  const absolute = request.startsWith('.') ? path.resolve(path.dirname(originPath), request) : request;
  if (WEB_SHIMS[absolute]) return { filePath: WEB_SHIMS[absolute] };
  if (!fromWeb) return { filePath: absolute };
  const isPathLike = request.startsWith('.') || path.isAbsolute(request);
  if (!isPathLike) {
    throw new Error(
      `[openbear web-reuse guard] ${path.relative(webSrc, originPath)} 导入了未登记的包 "${moduleName}"；` +
        '如需复用，请在 mobile/web-reuse.config.js 的 WEB_SHIMS 中登记替身。',
    );
  }
  if (!isInside(webSrc, absolute) || !/\.m?js$/.test(absolute)) {
    throw new Error(
      `[openbear web-reuse guard] ${path.relative(webSrc, originPath)} 导入了非纯逻辑文件 "${moduleName}"（只允许 web/src 内的 .js）。`,
    );
  }
  return { filePath: absolute };
}

module.exports = { mobileRoot, webSrc, shimRoot, WEB_SHIMS, resolveWebReuse, isInside };

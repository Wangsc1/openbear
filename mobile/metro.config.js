// Metro 配置：通过 watchFolders + 解析器别名直接复用 ../web/src 的纯逻辑模块（设计 4.1 第一步），web/ 不做修改。
// 别名、替身表和解析守卫见 web-reuse.config.js（node --test 也用同一份规则）。
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { webSrc, resolveWebReuse } = require('./web-reuse.config');

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders || []), webSrc];

const upstreamResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = resolveWebReuse(moduleName, context.originModulePath || '');
  if (resolved.filePath) return { type: 'sourceFile', filePath: resolved.filePath };
  if (moduleName.startsWith('@/')) {
    return context.resolveRequest(context, path.join(projectRoot, 'src', moduleName.slice(2)), platform);
  }
  return (upstreamResolve || context.resolveRequest)(context, resolved.request, platform);
};

module.exports = config;

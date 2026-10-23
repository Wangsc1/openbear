// web/src/sessionBoundary.js 的 App 替身：浏览器文档级的网关会话、localStorage 分账号、跨标签广播在 App 里不存在；
// App 的服务器/账号隔离由 data/session.tsx 负责。复用的纯逻辑模块（references/catalog.js、attachmentDraftStorage.js）
// 只在导入时引用这些名字，App 不会走到需要浏览器的分支（catalog.js 的 startReferenceCatalog 不调用）。
export const pageSession = { initialized: true, mode: '', instanceId: '', username: '', contextToken: '', blocked: false };
export function isGateway() {
  return false;
}
export function onSessionEnd() {
  return () => {};
}
export function userStorage(storage) {
  return storage;
}
export function userDatabaseName(name) {
  return name;
}
export function contextWebSocket() {
  throw new Error('contextWebSocket is not used in the App: WebSockets belong to data/session.tsx');
}

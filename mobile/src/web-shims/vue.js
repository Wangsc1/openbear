// web/src/references/catalog.js 只用 shallowReactive 包一个状态对象。App 里它就是普通对象，
// 变化由 src/references/catalogStore.ts 的版本号通知 React。
export function shallowReactive(value) {
  return value;
}

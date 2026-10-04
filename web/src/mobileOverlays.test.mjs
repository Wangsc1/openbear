import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import postcss from 'postcss';
import {parse} from '@vue/compiler-sfc';
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const root = postcss.parse(read('./mobile-overlays.css'));
function rule(selector) {
  const result = {};
  root.walkRules(node => { if (node.selectors.includes(selector)) node.walkDecls(d => {result[d.prop] = d.value;}); });
  return result;
}
// Evaluate the actual CSS arithmetic with deterministic viewport/safe-area
// values. This is a declaration contract, not a browser layout simulation.
function value(expression, {height = 430, top = 35, width = 390, safeTop = 47, safeBottom = 34, safeLeft = 0, safeRight = 0, percent = width} = {}) {
  const vars = {'--mobile-viewport-height':height, '--mobile-viewport-top':top};
  const safe = {'safe-area-inset-top':safeTop, 'safe-area-inset-bottom':safeBottom, 'safe-area-inset-left':safeLeft, 'safe-area-inset-right':safeRight};
  let text = expression.replace(/var\(([^,]+),\s*[^)]+\)/g, (_,name) => vars[name])
    .replace(/env\(([^,]+),\s*[^)]+\)/g, (_,name) => safe[name])
    .replace(/(\d+(?:\.\d+)?)dvh/g, (_,n) => Number(n) * height / 100)
    .replace(/(\d+(?:\.\d+)?)%/g, (_,n) => Number(n) * percent / 100)
    .replace(/px/g, '').replace(/calc\(/g, '(').replace(/\b(max|min)\(/g, 'Math.$1(');
  assert.match(text, /^[\d\s.+*/(),\-a-zA-Z]+$/);
  return vm.runInNewContext(text);
}
function template(path) { return parse(read(path)).descriptor.template.content; }

test('overlay rules are opt-in and mobile-only, without changing desktop shell or zoom', () => {
  root.walkRules(node => {
    assert.equal(node.parent.type, 'atrule');
    assert.equal(node.parent.name, 'media');
    assert.equal(node.parent.params, '(max-width: 760px), (hover: none) and (pointer: coarse)');
    assert.match(node.selector, /mobile-viewport-(dialog|drawer|sheet)|mobile-select-popper/);
  });
  assert.match(read('./main.js'), /import "\.\/mobile-overlays\.css"/);
  assert.doesNotMatch(read('./mobile-overlays.css'), /touch-action|user-scalable|maximum-scale/);
});

test('search, memory, context editing, directory and version dialogs opt into body-level viewport geometry', () => {
  for (const [file, component, name] of [
    ['./App.vue','el-dialog','version-dialog'],
    ['./views/consoleView/TaskMemoryDrawer.vue','el-dialog','task-memory-editor'],
    ['./views/consoleView/ContextEditor.vue','el-dialog','ce-edit-dialog'],
    ['./components/ConversationTree.vue','el-dialog','folder-properties-dialog'],
    ['./views/consoleView/ConversationSearch.vue','el-drawer','conversation-search-drawer'],
    ['./views/consoleView/TaskMemoryDrawer.vue','el-drawer','task-memory-drawer'],
  ]) {
    const opening = template(file).match(new RegExp(`<${component}\\b[^>]*class="[^"]*${name}[^>]*>`))?.[0];
    assert.ok(opening, `${file}: named overlay`);
    assert.match(opening, /mobile-viewport-(dialog|drawer)/);
    assert.match(opening, /append-to-body/);
  }
  assert.match(template('./components/ConversationTree.vue'), /v-model="moveDialog" class="mobile-viewport-dialog"/);
});

test('dialog top, height and width fit portrait, narrow phone and landscape keyboard bounds', () => {
  const dialog = rule('html .mobile-viewport-dialog.el-dialog');
  assert.equal(dialog.display, 'flex'); assert.equal(dialog['flex-direction'], 'column');
  assert.equal(dialog.overflow, 'hidden'); assert.equal(dialog['box-sizing'], 'border-box');
  for (const env of [
    {width:390,height:430,top:35,safeTop:47,safeBottom:34,safeLeft:0,safeRight:0},
    {width:320,height:300,top:0,safeTop:0,safeBottom:0,safeLeft:0,safeRight:0},
    {width:844,height:210,top:16,safeTop:0,safeBottom:21,safeLeft:47,safeRight:0},
    {width:844,height:210,top:16,safeTop:0,safeBottom:21,safeLeft:0,safeRight:47},
  ]) {
    const marginTop = value(dialog.margin.replace(/ auto 0$/, ''), env);
    const height = value(dialog['max-height'], env);
    assert.equal(marginTop, env.top + Math.max(8,env.safeTop));
    assert.equal(marginTop + height, env.top + env.height - Math.max(8,env.safeBottom));
    assert.equal(value(dialog['max-width'], env), env.width - 2 * Math.max(8,env.safeLeft,env.safeRight));
  }
});

test('dialog headers and footers do not scroll away; normal body shrinks and Monaco keeps its own scroller', () => {
  for (const part of ['header','footer']) assert.equal(rule(`html .mobile-viewport-dialog > .el-dialog__${part}`).flex,'none');
  const body = rule('html .mobile-viewport-dialog > .el-dialog__body');
  assert.equal(body['min-height'],'0');assert.equal(body['overflow-y'],'auto');
  assert.equal(rule('html .mobile-viewport-dialog.ce-edit-dialog > .el-dialog__body').overflow,'hidden');
  assert.equal(rule('html .mobile-viewport-dialog.version-dialog .version-notes-md')['max-height'],'none');
});

test('drawers and bottom sheets follow the visible keyboard edge instead of the layout bottom', () => {
  const drawer = rule('html .mobile-viewport-drawer.el-drawer');
  assert.equal(value(drawer.top),82);assert.equal(value(drawer.height),383);assert.equal(drawer.bottom,'auto');
  const body = rule('html .mobile-viewport-drawer > .el-drawer__body');
  assert.equal(value(body['padding-left'],{safeLeft:47}),47);
  assert.equal(value(body['padding-right'],{safeRight:47}),47);
  const bottom = rule('html .mobile-viewport-sheet.el-drawer').bottom;
  assert.equal(value(bottom,{height:430,top:35,percent:800}),335);
  assert.equal(value(bottom,{height:800,top:0,percent:800}),0);
  assert.equal(rule('html .conversation-search-drawer.mobile-viewport-drawer > .el-drawer__body').overflow,'hidden');
});

test('management and mobile asset overlays independently reserve landscape safe areas', () => {
  const admin = postcss.parse(read('./admin-mobile.css'));
  for (const selector of ['.admin-dialog .el-dialog__header','.admin-dialog .el-dialog__body','.admin-dialog .el-dialog__footer','.admin-drawer .el-drawer__header','.admin-drawer .el-drawer__body','.admin-drawer .el-drawer__footer']) {
    let padding;admin.walkRules(node => { if(node.selectors.includes(selector)) node.walkDecls('padding',d=>{padding=d.value;}); });
    assert.match(padding,/safe-area-inset-left/);assert.match(padding,/safe-area-inset-right/);
  }
  assert.match(template('./components/MobileAssetSheet.vue'),/mobile-asset-sheet mobile-viewport-sheet/);
});

test('native history navigation closes stale sidebar/menu but still applies the requested route', () => {
  const app = read('./App.vue');
  const fn = app.match(/function handleHistoryNavigation\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn);
  const calls=[];
  const context=vm.createContext({closeSidebar:()=>calls.push('sidebar'),closeConversationMenu:()=>calls.push('menu'),applyRouteFromLocation:()=>calls.push('route'),
    window:{history:{state:{openbearRoutePosition:0},go:()=>calls.push('go')},location:{pathname:'/docs',search:''}},
    ROUTE_POSITION:'openbearRoutePosition',restoringPosition:null,navigationSequence:0,historyNavigationPending:false,routePosition:1,routeLocation:'/chat',active:{value:'console'},pathToPage:{'/docs':'docs'}});
  vm.runInContext(fn+'\nhandleHistoryNavigation();',context);
  assert.deepEqual(calls,['sidebar','menu','route']);
  assert.match(app,/addEventListener\("popstate", handleHistoryNavigation\)/);
  assert.match(app,/removeEventListener\("popstate", handleHistoryNavigation\)/);
  assert.equal(context.routePosition,0,'non-Cron back keeps the requested native history entry');
  assert.equal(context.routeLocation,'/docs');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';
import {parse, compileScript} from '@vue/compiler-sfc';
import {bindMobileEditorFontSize, MOBILE_INPUT_QUERY} from './mobileInput.js';
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const sheet = postcss.parse(read('./mobile-inputs.css'));
const media = sheet.nodes.find(n => n.type === 'atrule');
const rule = media.nodes.find(n => n.type === 'rule');
function matches(query, env) {
  return query.split(',').some(part => [...part.matchAll(/\(([^)]+)\)/g)].every(([, atom]) => {
    const [key,value] = atom.split(':').map(s=>s.trim());
    if (key === 'max-width') return env.width <= parseFloat(value);
    if (key === 'min-width') return env.width >= parseFloat(value);
    return env[key] === value;
  }));
}
test('mobile input floor covers small screens and landscape touch devices without altering desktop or pinch zoom', () => {
  assert.equal(media.params,MOBILE_INPUT_QUERY);
  for (const env of [{width:390,hover:'none',pointer:'coarse'},{width:844,hover:'none',pointer:'coarse'},{width:1024,hover:'none',pointer:'coarse'},{width:600,hover:'hover',pointer:'fine'},
    {width:1024,hover:'hover',pointer:'fine','any-pointer':'coarse'}, // iPad plus trackpad: touchscreen remains available
    {width:1440,hover:'hover',pointer:'fine','any-pointer':'coarse'} // touch-capable laptop
  ]) assert.equal(matches(media.params,env),true);
  assert.equal(matches(media.params,{width:1440,hover:'hover',pointer:'fine','any-pointer':'fine'}),false);
  assert.equal(matches(media.params,{width:1024,hover:'hover',pointer:'fine','any-pointer':'fine'}),false);
  assert.deepEqual(rule.nodes.map(n=>[n.prop,n.value,n.important]),[['font-size','var(--ob-chat-input-font-size, 16px)',true]]);
  const main=read('./main.js');assert.ok(main.indexOf('import "./mobile-inputs.css"')>main.indexOf('import "./admin-mobile.css"'));
  assert.doesNotMatch(read('../index.html'),/maximum-scale|user-scalable/);
});
test('the shared rule reaches native/Element forms, teleported dialogs, rich text and mobile native editors', () => {
  const input=rule.selectors.find(s=>s.startsWith('input'));
  assert.ok(input);
  for(const type of ['checkbox','radio','range','color','hidden','button','submit','reset','file','image']) assert.ok(input.includes(`:not([type="${type}"])`));
  for(const type of ['text','search','email','password','number','url','tel','date','time']) assert.ok(!input.includes(`:not([type="${type}"])`));
  for(const selector of ['textarea','select','[contenteditable]:not([contenteditable="false"])','.el-select__wrapper','.reference-editor-placeholder']) assert.ok(rule.selectors.includes(selector),selector);
  // No app/dialog ancestor restriction: Element Plus teleports overlays to body.
  assert.ok(rule.selectors.every(s=>!s.includes('#app')&&!s.includes('.app-shell')));
});
test('compact chat fields restore desktop sizes even on touch PCs, while iPhone/iPad keep zoom-safe inputs', () => {
  const nativeInput = rule.selectors.find(selector => selector.startsWith('input'));
  const controls = [
    {selector: '.conversation-tree .tree-search input', mobile: nativeInput, font: '12px', file: './components/ConversationTree.vue', base: '.tree-search input'},
    {selector: '.composer-shell .reference-editor-content', mobile: '[contenteditable]:not([contenteditable="false"])', font: '14px', file: './references/ReferenceEditor.vue', base: '.reference-editor-content'},
    {selector: '.composer-shell .reference-editor-placeholder', mobile: '.reference-editor-placeholder', font: '14px', file: './references/ReferenceEditor.vue', base: '.reference-editor-placeholder'},
    {selector: '.run-config-menu-popper .model-search input', mobile: nativeInput, font: '13px', file: './views/consoleView/ConsoleComposer.vue', base: '.model-search input'},
  ];
  function sharedFont(selectors, env, initial) {
    let font = initial, desktopSize;
    sheet.walkRules(candidate => {
      if (!candidate.selectors.some(selector => selectors.includes(selector))) return;
      for (let parent = candidate.parent; parent; parent = parent.parent) {
        if (parent.type !== 'atrule') continue;
        if (parent.name === 'media' && !matches(parent.params, env)) return;
        if (parent.name === 'supports') {
          assert.equal(parent.params, 'not (-webkit-touch-callout: none)');
          if (env.ios) return;
        }
      }
      candidate.walkDecls(decl => {
        if (decl.prop === 'font-size') { assert.equal(decl.important, true); font = decl.value; }
        if (decl.prop === '--ob-chat-input-font-size') desktopSize = decl.value;
      });
    });
    return font === 'var(--ob-chat-input-font-size, 16px)' ? (desktopSize || '16px') : font;
  }
  const desktop = {width:1440, hover:'hover', pointer:'fine', 'any-pointer':'fine', ios:false};
  const phone = {width:390, hover:'none', pointer:'coarse', 'any-pointer':'coarse', ios:true};
  for (const control of controls) {
    let correction;
    sheet.walkRules(candidate => { if (candidate.selectors.includes(control.selector)) correction = candidate; });
    assert.deepEqual(correction.nodes.map(decl => [decl.prop, decl.value]), [['--ob-chat-input-font-size', control.font]], 'desktop size feeds the existing high-specificity rule rather than losing an !important contest');
    const {descriptor} = parse(read(control.file));
    const componentCss = postcss.parse(descriptor.styles.map(style => style.content).join('\n'));
    let baseFont;
    componentCss.walkRules(candidate => {
      if (candidate.parent.type === 'root' && candidate.selectors.includes(control.base)) candidate.walkDecls('font-size', decl => {baseFont = decl.value;});
    });
    assert.equal(baseFont, control.font, 'desktop correction matches the existing component scale');
    const font = env => sharedFont([control.mobile, control.selector], env, baseFont);
    for (const env of [desktop, {...desktop, 'any-pointer':'coarse'}, {...desktop, width:1024, 'any-pointer':'coarse'}]) assert.equal(font(env), control.font, control.selector);
    for (const env of [phone, {...phone, width:844}, {...phone, width:1024, hover:'hover', pointer:'fine'}, {...desktop, width:600, 'any-pointer':'coarse'}, {...phone, ios:false}]) assert.equal(font(env), '16px', control.selector);
  }
  assert.equal(sharedFont([nativeInput], {...desktop, 'any-pointer':'coarse'}, '13px'), '16px', 'unrelated form inputs keep their existing mobile policy');
});

test('Monaco font measurements follow the same media query and restore desktop sizing, releasing listeners on unmount', () => {
  const listeners=new Set(),options=[];
  const media={matches:true,addEventListener:(name,fn)=>{assert.equal(name,'change');listeners.add(fn);},removeEventListener:(_,fn)=>listeners.delete(fn)};
  const stop=bindMobileEditorFontSize({updateOptions:value=>options.push(value)},{matchMedia:query=>{assert.equal(query,MOBILE_INPUT_QUERY);return media;}});
  assert.deepEqual(options,[{fontSize:16}]);
  media.matches=false;for(const fn of listeners)fn();assert.deepEqual(options.at(-1),{fontSize:13});
  media.matches=true;for(const fn of listeners)fn();assert.deepEqual(options.at(-1),{fontSize:16});
  stop();assert.equal(listeners.size,0);
  // A pointer can become fine while the touchscreen still exists. CSS and Monaco
  // must keep the same 16px floor until all touch input is gone.
  let env={width:1024,hover:'none',pointer:'coarse','any-pointer':'coarse'};
  const updates=[], callbacks=new Set();
  const touchMedia={get matches(){return matches(MOBILE_INPUT_QUERY,env);},addEventListener:(_,fn)=>callbacks.add(fn),removeEventListener:(_,fn)=>callbacks.delete(fn)};
  const unbind=bindMobileEditorFontSize({updateOptions:value=>updates.push(value.fontSize)},{matchMedia:()=>touchMedia});
  env={...env,hover:'hover',pointer:'fine'};for(const fn of callbacks)fn();
  env={...env,'any-pointer':'fine'};for(const fn of callbacks)fn();
  assert.deepEqual(updates,[16,16,13]);unbind();assert.equal(callbacks.size,0);
  for(const file of ['./components/MdEditor.vue','./views/consoleView/contextEditor/CodeEditor.vue']) {
    const {descriptor}=parse(read(file));compileScript(descriptor,{id:file});
    assert.match(descriptor.scriptSetup.content,/\w+ = bindMobileEditorFontSize\(editor\)/);
    assert.match(descriptor.scriptSetup.content,/onBeforeUnmount\([\s\S]*(?:stopFontSubscription|fontSubscription)\?\.\(\)/);
  }
});

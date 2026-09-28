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
    return key === 'max-width' ? env.width <= parseFloat(value) : env[key] === value;
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
  assert.deepEqual(rule.nodes.map(n=>[n.prop,n.value,n.important]),[['font-size','16px',true]]);
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

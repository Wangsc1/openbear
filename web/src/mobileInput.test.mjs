import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import postcss from 'postcss';
import {parse, compileScript} from '@vue/compiler-sfc';
import {bindMobileEditorFontSize, MOBILE_INPUT_QUERY, IOS_INPUT_QUERY} from './mobileInput.js';
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
function sharedFont(selector, env, initial) {
  let font = initial;
  sheet.walkRules(candidate => {
    if (!candidate.selectors.includes(selector)) return;
    for (let parent = candidate.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule') continue;
      if (parent.name === 'media' && !matches(parent.params, env)) return;
      if (parent.name === 'supports') {
        assert.equal(parent.params, '(-webkit-touch-callout: none)');
        if (!env.ios) return;
      }
    }
    candidate.walkDecls('font-size', decl => { assert.equal(decl.important, true); font = decl.value; });
  });
  return font;
}
const desktop = {width:1440, hover:'hover', pointer:'fine', 'any-pointer':'fine', ios:false};
const phone = {width:390, hover:'none', pointer:'coarse', 'any-pointer':'coarse', ios:true};
const cases = [
  ['desktop', desktop, false],
  ['touchscreen PC with mouse', {...desktop, 'any-pointer':'coarse'}, false],
  ['narrow desktop', {...desktop, width:600}, false],
  ['narrow touchscreen PC with mouse', {...desktop, width:600, 'any-pointer':'coarse'}, false],
  ['wide touch-only PC', {...phone, width:1440, ios:false}, false],
  ['iPhone portrait', phone, true],
  ['iPhone landscape', {...phone, width:844}, true],
  ['iPad', {...phone, width:1024}, true],
  ['iPad with trackpad', {...phone, width:1024, hover:'hover', pointer:'fine'}, true],
  ['Android phone', {...phone, ios:false}, true],
];

test('mobile CSS and editor queries agree, without suppressing pinch zoom', () => {
  assert.equal(media.params, MOBILE_INPUT_QUERY);
  const ios = sheet.nodes.find(n => n.name === 'supports');
  assert.equal(ios.params, '(-webkit-touch-callout: none)');
  assert.equal(ios.nodes[0].params, IOS_INPUT_QUERY);
  const iosRule = ios.nodes[0].nodes[0];
  assert.deepEqual(iosRule.selectors, rule.selectors);
  for (const candidate of [rule, iosRule]) assert.deepEqual(candidate.nodes.map(n=>[n.prop,n.value,n.important]), [['font-size','16px',true]]);
  const main=read('./main.js');assert.ok(main.indexOf('import "./mobile-inputs.css"')>main.indexOf('import "./admin-mobile.css"'));
  assert.doesNotMatch(read('../index.html'),/maximum-scale|user-scalable/);
});
test('the shared rule reaches native/Element forms, teleported dialogs, rich text and mobile native editors', () => {
  const input=rule.selectors.find(s=>s.startsWith('input'));
  assert.ok(input);
  for(const type of ['checkbox','radio','range','color','hidden','button','submit','reset','file','image']) assert.ok(input.includes(`:not([type="${type}"])`));
  for(const type of ['text','search','email','password','number','url','tel','date','time']) assert.ok(!input.includes(`:not([type="${type}"])`));
  for(const selector of ['textarea','select','[contenteditable]:not([contenteditable="false"])','.el-select__wrapper','.reference-editor-placeholder']) assert.ok(rule.selectors.includes(selector),selector);
  assert.ok(rule.selectors.every(s=>!s.includes('#app')&&!s.includes('.app-shell')));
});
for (const [name, env, mobile] of cases) test(`${name}: all editable controls and Monaco use the same sizing policy`, () => {
  for (const selector of rule.selectors) {
    for (const base of ['12px', '13px', '14px']) assert.equal(sharedFont(selector, env, base), mobile ? '16px' : base, selector);
  }
  const listeners = new Set(), options = [];
  const stop = bindMobileEditorFontSize({updateOptions:value=>options.push(value)}, {
    CSS: {supports:(property,value)=>{assert.equal(property,'-webkit-touch-callout');assert.equal(value,'none');return env.ios;}},
    matchMedia:query=>({matches:matches(query,env),addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn)}),
  });
  assert.deepEqual(options, [{fontSize:mobile ? 16 : 13}]);
  stop(); assert.equal(listeners.size, 0);
});

test('Monaco responds to width/pointer changes and releases both modern and legacy listeners', () => {
  for (const legacy of [false, true]) {
    let env = {...phone};
    const queries = [], options = [];
    const stop = bindMobileEditorFontSize({updateOptions:value=>options.push(value.fontSize)}, {
      CSS: {supports:()=>true},
      matchMedia:query=>{
        const listeners = new Set();
        queries.push(listeners);
        return {get matches(){return matches(query,env);}, ...(legacy ? {
          addListener:fn=>listeners.add(fn), removeListener:fn=>listeners.delete(fn),
        } : {addEventListener:(_,fn)=>listeners.add(fn), removeEventListener:(_,fn)=>listeners.delete(fn)})};
      },
    });
    assert.equal(queries.length, 2);
    for (const next of [{...phone,width:844}, {...phone,width:1024,hover:'hover',pointer:'fine'}, desktop, phone]) {
      env = next;
      for (const fn of new Set(queries.flatMap(listeners=>[...listeners]))) fn();
    }
    assert.deepEqual(options, [16,16,16,13,16]);
    stop(); for (const listeners of queries) assert.equal(listeners.size, 0);
  }
  const options = [];
  bindMobileEditorFontSize({updateOptions:value=>options.push(value)}, {})();
  assert.deepEqual(options, [{fontSize:13}]);
  for(const file of ['./components/MdEditor.vue','./views/consoleView/contextEditor/CodeEditor.vue']) {
    const {descriptor}=parse(read(file));compileScript(descriptor,{id:file});
    assert.match(descriptor.scriptSetup.content,/\w+ = bindMobileEditorFontSize\(editor\)/);
    assert.match(descriptor.scriptSetup.content,/onBeforeUnmount\([\s\S]*(?:stopFontSubscription|fontSubscription)\?\.\(\)/);
  }
});

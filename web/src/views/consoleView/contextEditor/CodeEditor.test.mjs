import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, unlink} from 'node:fs/promises';
import {compileScript, compileTemplate, parse} from '@vue/compiler-sfc';
import {effectScope, nextTick, reactive} from 'vue';
const source = await readFile(new URL('./CodeEditor.vue',import.meta.url),'utf8');
const {descriptor,errors}=parse(source);
assert.deepEqual(errors,[]);
assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:'CodeEditor.vue',id:'code-test'}).errors,[]);
const path=new URL(`./.CodeEditor.test-${process.pid}.mjs`,import.meta.url);
const hooks={mounted:[],unmount:[]}, listeners=new Map();
let model, editor, options, changed, blurred, modelDisposed, editorDisposed, unsubscribed;
const monaco={
 editor:{
  defineTheme(){},setModelLanguage(m,language){m.language=language;},
  createModel(value,language){model={value,language,setValue(v){this.value=v;changed?.();},getFullModelRange(){return {};},dispose(){modelDisposed=true;}};return model;},
  create(host,value){options=value;editor={getValue:()=>model.value,onDidChangeModelContent(fn){changed=fn;return {dispose(){}};},onDidBlurEditorWidget(fn){blurred=fn;return {dispose(){}};},updateOptions(value){Object.assign(options,value);},executeEdits(_source,edits){model.setValue(edits[0].text);},focus(){},dispose(){editorDisposed=true;}};return editor;},
 },
};
globalThis.__ceMock={monaco,hooks,stopTheme:()=>{unsubscribed=true;}};
const globals={document:globalThis.document,getComputedStyle:globalThis.getComputedStyle};
globalThis.document={documentElement:{},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
globalThis.getComputedStyle=()=>({getPropertyValue:()=> '20 20 20'});
let Component;
try {
 const compiled=compileScript(descriptor,{id:'code-test'}).content
 .replace("import {onMounted, onBeforeUnmount, ref, watch} from 'vue';", "import {ref,watch} from 'vue'; const onMounted=fn=>globalThis.__ceMock.hooks.mounted.push(fn); const onBeforeUnmount=fn=>globalThis.__ceMock.hooks.unmount.push(fn);")
 .replace("import * as monaco from 'monaco-editor';",'const monaco=globalThis.__ceMock.monaco;')
 .replace("import {isDarkTheme, subscribeTheme} from '../../../theme.js';",'const isDarkTheme=()=>false, subscribeTheme=()=>globalThis.__ceMock.stopTheme;');
 await writeFile(path,compiled);({default:Component}=await import(path.href));
} finally {await unlink(path).catch(()=>{});}
after(()=>{delete globalThis.__ceMock;for(const [key,value] of Object.entries(globals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}});
function setup(overrides={}) {
 hooks.mounted=[];hooks.unmount=[];modelDisposed=false;editorDisposed=false;unsubscribed=false;changed=null;
 const props=reactive({modelValue:'{"value":1}',language:'json',readonly:false,label:'JSON 编辑',identity:{scope:'chat',id:'entry',field:'content'},...overrides});
 const scope=effectScope(),events=[];let exposed;
 const vm=scope.run(()=>Component.setup(props,{expose:value=>{exposed=value;},emit:(...args)=>events.push(args)}));
 vm.host.value={contains:target=>target==='inside'};hooks.mounted.forEach(fn=>fn());
 return {props,vm,exposed,events,stop(){hooks.unmount.forEach(fn=>fn());scope.stop();}};
}
test('JSON editor enables syntax language, colored brackets, folding and responsive layout',()=>{
 const {stop}=setup();assert.equal(model.language,'json');assert.equal(options.automaticLayout,true);assert.equal(options.bracketPairColorization.enabled,true);assert.equal(options.folding,true);assert.equal(options.showFoldingControls,'always');assert.equal(options.wordWrap,'on');assert.equal(options.readOnly,false);stop();
 assert.equal(modelDisposed,true);assert.equal(editorDisposed,true);assert.equal(unsubscribed,true);assert.equal(listeners.size,0);
});
test('text flush occurs before outside actions, uses original identity and never duplicates on blur/unmount',()=>{
 const {vm,props,events,stop}=setup();model.setValue('latest text');assert.equal(vm.dirty.value,true);assert.deepEqual(events,[['update:modelValue','latest text']]);
 props.identity.id='different-selection';listeners.get('pointerdown')({target:'inside'});assert.equal(events.length,1);
 listeners.get('pointerdown')({target:'outside'});assert.deepEqual(events.at(-1),['change',{scope:'chat',id:'entry',field:'content',value:'latest text'}]);assert.equal(vm.dirty.value,false);
 blurred();stop();assert.equal(events.filter(e=>e[0]==='change').length,1);
});
test('undo prop updates replace text without emitting changes; readonly preview cannot commit or format',async()=>{
 const {props,events,stop}=setup();props.modelValue='{"restored":true}';await nextTick();assert.equal(model.value,'{"restored":true}');assert.equal(events.length,0);
 props.language='markdown';props.readonly=true;await nextTick();assert.equal(model.language,'markdown');assert.equal(options.readOnly,true);stop();assert.equal(events.length,0);
 const view=setup({readonly:true});view.vm.format();assert.equal(model.value,'{"value":1}');view.exposed.flush();view.stop();assert.equal(view.events.length,0);
});
test('formatting preserves valid JSON and keeps invalid input available with a visible error',()=>{
 const {vm,events,stop}=setup();vm.format();assert.equal(model.value,'{\n  "value": 1\n}');assert.equal(vm.error.value,'');
 model.setValue('{broken');vm.format();assert.equal(model.value,'{broken');assert.ok(vm.error.value);assert.ok(events.some(e=>e[0]==='update:modelValue'));stop();
});

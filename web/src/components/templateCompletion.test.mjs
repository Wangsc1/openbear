import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as Vue from 'vue';
import {parse} from '@vue/compiler-sfc';

const source=parse(fs.readFileSync(new URL('./MdEditor.vue',import.meta.url),'utf8')).descriptor.scriptSetup.content.replace(/^import .*;\n/gm,'');
function editors() {
  const sharedWindow={}, registrations=[];
  const monaco={languages:{CompletionItemKind:{Variable:1,Function:2,Keyword:3,Value:4,Reference:5},CompletionItemInsertTextRule:{InsertAsSnippet:4},registerCompletionItemProvider(language,provider){registrations.push({language,provider});}},editor:{defineTheme(){},setTheme(){}}};
  function mount(mode,text,refData={mem:[],secret:[],doc:[]},completionRoots=null) {
    const props=Vue.reactive({modelValue:text,readOnly:false,completionMode:mode,refData,completionRoots,language:'markdown'}),mounts=[],cleanups=[],scope=Vue.effectScope();
    const model={getValueInRange:()=>props.modelValue};let focus;
    const instance={getModel:()=>model,onDidFocusEditorWidget:fn=>{focus=fn;},onDidChangeModelContent(){},getValue:()=>props.modelValue,dispose(){}};
    monaco.editor.create=()=>instance;
    const ctx=vm.createContext({...Vue,window:sharedWindow,monaco,defineProps:()=>props,defineEmits:()=>()=>{},onMounted:fn=>mounts.push(fn),onBeforeUnmount:fn=>cleanups.push(fn),
      document:{documentElement:{}},getComputedStyle:()=>({getPropertyValue:()=>''}),editorTheme:()=>({}),isDarkTheme:()=>false,subscribeTheme:()=>()=>{},bindMobileEditorFontSize:()=>()=>{}});
    scope.run(()=>vm.runInContext(source,ctx));mounts.forEach(fn=>fn());
    return {props,model,focus:()=>focus(),suggest(){return registrations[0].provider.provideCompletionItems(model,{lineNumber:1,column:props.modelValue.length+1}).suggestions;},close(){cleanups.forEach(fn=>fn());scope.stop();}};
  }
  return {mount,registrations};
}

test('template/none/memory editors keep completion context per model across background mounts, props changes and focus',async()=>{
  const h=editors();const template=h.mount('template','[[ time.');const plain=h.mount('none','[[ time.');
  assert.equal(h.registrations.length,1);assert.equal(plain.suggest().length,0);
  assert.ok(template.suggest().some(item=>item.label==='[[ time.now ]]'),'plain editor mounting must not disable template editor completion');
  const memory=h.mount('memory','@mem/',{mem:[{key:'only-this-editor',name:'Name'}],secret:[],doc:[]});
  assert.equal(memory.suggest()[0].insertText,'only-this-editor');assert.ok(template.suggest().length>0);
  plain.props.refData={mem:[{key:'unrelated'}]};await Vue.nextTick();assert.ok(template.suggest().length>0);assert.equal(memory.suggest()[0].insertText,'only-this-editor');
  plain.focus();assert.equal(plain.suggest().length,0);assert.ok(template.suggest().length>0);
  plain.props.completionMode='template';await Vue.nextTick();assert.ok(plain.suggest().length>0);
  template.close();assert.equal(template.suggest().length,0);assert.ok(plain.suggest().length>0);plain.close();memory.close();
});

test('all contract variables, helper descriptions and template snippets remain available in the shared mode',()=>{
  const h=editors();const template=h.mount('template','[[ ');
  const suggestions=template.suggest();
  const variables=['time.now','time.iso','time.date','time.clock','time.weekday','time.timezone','time.utcOffset','time.timestamp','message.id','message.source','message.sentAt','message.attachmentCount','message.attachments','conversation.id','conversation.title','conversation.folderPath','runtimeInfo.model','runtimeInfo.host','runtimeInfo.os','folderWorkspaceDir'];
  for(const variable of variables){const item=suggestions.find(item=>item.label===`[[ ${variable} ]]`);assert.ok(item,variable);assert.ok(item.detail);}
  assert.ok(suggestions.some(item=>item.label.includes('helpers.toolLines(')));
  template.props.modelValue='  @';assert.ok(template.suggest().some(item=>item.insertText.includes('@endif')));
  template.close();
});


test('global tail completion limits roots/leaf paths and excludes system-only snippets without limiting directory templates',async()=>{
  const h=editors(),roots=['time','message','conversation','runtimeInfo.model','runtimeInfo.host','runtimeInfo.os','folderWorkspaceDir'];
  const full=h.mount('template','[[ '),tail=h.mount('template','[[ ',undefined,roots);
  const expressions=tail.suggest().map(item=>item.insertText.slice(3,-3));
  assert.equal(expressions.length,20);
  for(const expression of expressions) assert.ok(roots.some(root=>expression===root||expression.startsWith(root+'.')),expression);
  assert.ok(full.suggest().some(item=>item.label.includes('memory.expandedEntries')));
  tail.props.modelValue='@';assert.ok(tail.suggest().some(item=>item.label==='@if'));
  assert.ok(tail.suggest().every(item=>!item.insertText.includes('memory.')));
  tail.props.completionRoots=['time'];tail.props.modelValue='[[ ';await Vue.nextTick();assert.equal(tail.suggest().length,8);assert.ok(full.suggest().length>20);
  full.close();tail.close();
});

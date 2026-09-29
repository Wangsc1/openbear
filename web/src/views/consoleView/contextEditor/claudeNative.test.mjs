import test from 'node:test';
import assert from 'node:assert/strict';
import {clone, callImpact, deleteCall, nativeConflicts, reconcileMessage, nativeCall, importPackage, exportPackage} from './operations.js';
import {messageSequence, moveBlock, replaceBlock} from './sequence.js';
const sample=()=>({role:'assistant',content:'AB',reasoning:'signed',signature:'sig',tool_calls:[{id:'c1',name:'Read',arguments:'{ "path": "甲", "offset": 0 }',vendor:1},{id:'c2',name:'Read',arguments:'{}'}],native_output_items:[
  {type:'thinking',thinking:'signed',signature:'sig',vendor:{keep:true}},
  {type:'text',text:'A',citations:[{keep:1}]},
  {type:'tool_use',id:'c1',name:'Read',input:{offset:0,path:'甲'},vendor:'keep'},
  {type:'text',text:'B'},
  {type:'tool_use',id:'c2',name:'Read',input:{}},
]});
test('complete Claude sequence renders text/tool labels and treats object argument formatting semantically',()=>{
  const m=sample(),seq=messageSequence(m);assert.equal(seq.ordered,true);
  assert.deepEqual(seq.rows.map(r=>r.type),['thinking','text','tool_use','text','tool_use']);
  assert.deepEqual(seq.rows.map(r=>r.label),['思考','正文','工具调用 · Read','正文','工具调用 · Read']);
  assert.deepEqual(seq.rows.filter(r=>r.callId).map(r=>r.callId),['c1','c2']);
  assert.deepEqual(nativeConflicts(m),[]);
});
test('Claude native move and block edit retain exact sibling order, signatures, citations and neutral projections',()=>{
  const m=sample(),moved=moveBlock(m,'native-4',-1);
  assert.deepEqual(moved.native_output_items.map(b=>b.id||b.type),['thinking','text','c1','c2','text']);
  assert.deepEqual(moved.native_output_items[0],m.native_output_items[0]);assert.equal(moved.tool_calls[0].vendor,1);
  const row=messageSequence(m).rows[1];const edited=replaceBlock(m,row,{...row.value,text:'修改'});
  assert.equal(edited.content,'修改B');assert.deepEqual(edited.native_output_items[1].citations,[{keep:1}]);
  assert.deepEqual(edited.native_output_items.slice(2),m.native_output_items.slice(2));assert.deepEqual(nativeConflicts(edited),[]);
});
test('Claude call update/delete keeps text split around tools and removes only its paired result',()=>{
  const m=sample(),edited=clone(m);edited.tool_calls[0].arguments='{"path":"new"}';
  const next=reconcileMessage(m,edited);assert.deepEqual(next.native_output_items[2].input,{path:'new'});assert.equal(next.native_output_items[2].vendor,'keep');
  assert.deepEqual(next.native_output_items.filter(n=>n.type==='text'),m.native_output_items.filter(n=>n.type==='text'));
  const doc={entries:[{entryId:'a',message:m},{entryId:'r1',message:{role:'tool',tool_call_id:'c1',content:'ok'}},{entryId:'r2',message:{role:'tool',tool_call_id:'c2',content:'ok'}}]};
  assert.ok(callImpact(doc,'a','c1').remove.includes('a.native_output_items[2]'));
  const deleted=deleteCall(doc,'a','c1');assert.deepEqual(deleted.entries.map(e=>e.entryId),['a','r2']);
  assert.deepEqual(deleted.entries[0].message.native_output_items.map(n=>n.id||n.type),['thinking','text','text','c2']);
  assert.deepEqual(nativeConflicts(deleted.entries[0].message),[]);assert.deepEqual(m,sample());
});
test('Claude insertion uses tool_use/input, conflicting raw edits are rejected, and full export/import is lossless',()=>{
  const m=sample(),n=clone(m);n.tool_calls.push({id:'c3',name:'Read',arguments:'{"path":"x"}'});
  n.native_output_items.push(nativeCall(n.tool_calls.at(-1),true));
  const next=reconcileMessage(m,n);assert.equal(next.native_output_items.at(-1).type,'tool_use');assert.deepEqual(nativeConflicts(next),[]);
  n.native_output_items[1].text='different';assert.throws(()=>reconcileMessage(m,n),/冲突/);
  assert.throws(()=>nativeCall({id:'x',name:'Read',arguments:'[]'},true),/JSON 对象/);
  const doc={format:'openbear-context-edit/1',system:'s',tools:[],entries:[{entryId:'a',message:m}]};
  assert.deepEqual(importPackage(exportPackage(doc,doc,'compatible','Claude')).working,doc);
});

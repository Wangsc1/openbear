import test from 'node:test';
import assert from 'node:assert/strict';
import {clone, callImpact, deleteCall, deleteEntries, deleteReasoning, diffDocument, exportPackage, importPackage, localIssues, nativeConflicts, reasoningImpact, reconcileMessage, relations, syncNative} from './operations.js';
const make = () => ({format:'openbear-context-edit/1', revision:1, origin:{protocol:'responses'}, runtime:{frozen:true}, system:'system', tools:[{name:'Read',description:'read',parameters:{type:'object'},vendor:'keep'}], entries:[
 {entryId:'a',message:{role:'assistant',content:'visible',signature:'signed',reasoning:'reason',tool_calls:[{id:'x',name:'Read',arguments:'{}'},{id:'y',name:'Search',arguments:'{}'}],native_output_items:[{type:'reasoning',encrypted_content:'opaque',extra:3},{type:'message',content:[{type:'output_text',text:'visible',annotations:[{type:'keep'}]}, {type:'vendor',data:{id:1}}],unknown:'keep'},{type:'function_call',call_id:'x',name:'Read',arguments:'{}',vendor:'unchanged'},{type:'function_call',call_id:'y',name:'Search',arguments:'{}'}],unknown:{a:1}}},
 {entryId:'rx',message:{role:'tool',tool_call_id:'x',content:'x'}}, {entryId:'ry',message:{role:'tool',tool_call_id:'y',content:'y'}},
 {entryId:'u',message:{role:'user',content:'next'}}, {entryId:'b',message:{role:'assistant',content:'answer',reasoning:'later',signature:'later-signed',native_output_items:[{type:'redacted_thinking',data:'opaque2'}]}}
]});
test('native Responses text/calls sync both directions and unknown fields never vanish', () => {
 const doc=make(), original=clone(doc.entries[0].message);
 const edited={...clone(original),content:'revised'};
 const synced=reconcileMessage(original,edited);
 assert.equal(synced.native_output_items[1].content[0].text,'revised');
 assert.deepEqual(synced.native_output_items[1].content[0].annotations,[{type:'keep'}]);
 assert.equal(synced.native_output_items[1].content[1].data.id,1);
 assert.equal(synced.native_output_items[2].vendor,'unchanged');
 const raw=clone(original);raw.native_output_items[1].content[0].text='native edit';
 assert.equal(reconcileMessage(original,raw).content,'native edit');
 raw.content='different';assert.throws(()=>reconcileMessage(original,raw),/同时改动且冲突/);
 assert.deepEqual(original,doc.entries[0].message);
 const none=clone(original);none.content='';syncNative(none);assert.equal(none.native_output_items[1].content[0].text,'');
});
test('Responses function-call-only message may omit content without a false conflict', () => {
 const m={role:'assistant',tool_calls:[{id:'id',name:'Read',arguments:'{}'}],native_output_items:[{type:'function_call',call_id:'id',name:'Read',arguments:'{}'}]};
 assert.deepEqual(nativeConflicts(m),[]);
 const changed=clone(m);changed.tool_calls[0].arguments='{"path":"a"}';
 assert.equal(reconcileMessage(m,changed).native_output_items[0].arguments,'{"path":"a"}');
});
test('Anthropic native-only thinking/redacted blocks do not project empty text or calls', () => {
 const m={role:'assistant',content:'keep me',tool_calls:[{id:'x',name:'Read',arguments:'{}'}],reasoning:'',signature:'s',native_output_items:[{type:'thinking',thinking:'',signature:'s',vendor:1},{type:'redacted_thinking',data:'encrypted',extra:2}]};
 const n=clone(m);n.content='still here';n.native_output_items[0].vendor=5;
 const result=reconcileMessage(m,n);
 assert.equal(result.content,'still here');assert.deepEqual(result.tool_calls,m.tool_calls);assert.equal(result.native_output_items[0].vendor,5);
 assert.deepEqual(nativeConflicts(result),[]);syncNative(result);assert.deepEqual(result.native_output_items,n.native_output_items);
});
test('call deletion is scoped to same assistant batch, preserves parallel call and native unknown fields', () => {
 const d=make(), impact=callImpact(d,'a','x');assert.deepEqual(impact.pair.results,['rx']);assert.deepEqual(impact.retain,['y']);
 const result=deleteCall(d,'a','x');assert.deepEqual(result.entries.map(e=>e.entryId),['a','ry','u','b']);
 const a=result.entries[0].message;assert.deepEqual(a.tool_calls.map(c=>c.id),['y']);assert.deepEqual(a.native_output_items.filter(n=>n.type==='function_call').map(n=>n.call_id),['y']);assert.equal(a.native_output_items[0].encrypted_content,'opaque');assert.equal(d.entries.length,5);
 const only=deleteCall(d,'a','x',true);assert.ok(only.entries.find(e=>e.entryId==='rx'));assert.ok(localIssues(only).some(i=>i.entryId==='rx'));
 const repeat=clone(d);repeat.entries.push({entryId:'a2',message:{role:'assistant',content:'repeat',tool_calls:[{id:'x',name:'Read',arguments:'{}'}]}},{entryId:'later',message:{role:'tool',tool_call_id:'x',content:'new'}});
 assert.deepEqual(callImpact(repeat,'a','x').pair.results,['rx']);assert.equal(deleteCall(repeat,'a','x').entries.at(-1).entryId,'later');
});
test('unknown call properties survive native edits; ambiguous duplicate IDs cannot cascade-delete', () => {
 const d=make(), old=d.entries[0].message;old.tool_calls[0].vendor={keep:true};
 assert.deepEqual(nativeConflicts(old),[]);
 const raw=clone(old);raw.native_output_items[2].arguments='{"changed":1}';
 const next=reconcileMessage(old,raw);assert.deepEqual(next.tool_calls[0].vendor,{keep:true});assert.equal(next.tool_calls[0].arguments,'{"changed":1}');
 d.entries[0].message.tool_calls.push({id:'x',name:'Other',arguments:'{}'});
 assert.throws(()=>callImpact(d,'a','x'),/重复/);
});
test('bulk deletion links both ways; thinking scope includes native opaque blocks without changing other content', () => {
 const d=make();assert.deepEqual(deleteEntries(d,['rx']).entries.map(e=>e.entryId),['a','ry','u','b']);
 assert.deepEqual(deleteEntries(d,['a']).entries.map(e=>e.entryId),['u','b']);
 assert.ok(reasoningImpact(d,'a').includes('b.native_output_items[0] (redacted_thinking)'));
 const one=deleteReasoning(d,'a',false);assert.equal(one.entries[0].message.native_output_items[0].type,'message');assert.equal(one.entries.at(-1).message.signature,'later-signed');
 const all=deleteReasoning(d,'a');assert.equal(all.entries.at(-1).message.native_output_items.length,0);assert.equal(all.entries.at(-1).message.content,'answer');assert.equal(d.entries[0].message.signature,'signed');
});
test('complete package proof normalization, full diff and immutable baseline', () => {
 const d=make();d.format='openbear-context-edit-proof/1';d.entries[0].message.content='x'.repeat(120_000);
 const p=importPackage(exportPackage(d,d,'raw','model-1'));assert.equal(p.baseline.format,'openbear-context-edit/1');assert.equal(p.working.entries[0].message.content.length,120_000);assert.equal(p.mode,'raw');assert.equal(p.targetModel,'model-1');
 const w=clone(p.working);w.entries[0].message.unknown={new:4};w.entries.reverse();assert.ok(diffDocument(p.baseline,w).some(x=>x.id==='order'));assert.equal(d.entries[0].message.unknown.a,1);
 assert.throws(()=>importPackage({working:d}),/完整上下文包/);
});

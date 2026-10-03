import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {effect, isProxy, markRaw, ref, shallowRef, stop, toRaw} from 'vue';
import {applyOperationFrame, normalizeOperations} from '../../timelineProjection.js';

const source=fs.readFileSync(new URL('./ConsoleView.vue',import.meta.url),'utf8');
function between(start,end){
	const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
	assert.ok(a>=0&&b>a);return source.slice(a,b);
}
function harness(){
	const ctx=vm.createContext({Map,ref,shallowRef,markRaw,toRaw,normalizeOperations,stateStatsByOpId:new Map()});
	vm.runInContext(`${between('const operationsById =','const lastStats =')}
		${between('function replaceOperationSnapshots(','function loadOperationsFromState(')}
		globalThis.refs={operationsById,orderedOpIds,revisionByOpId,lastFrameSeq};
		let streamFlushPending=true,streamFlushFrame=1,pendingProjectionOps=null;
		const orderedOperationsList=()=>orderedOpIds.value.map(id=>operationsById.value.get(id));
		${between('function flushProjectedMessages() {','\tconst beforeSignature =')} }
	`,ctx);
	return {ctx,refs:ctx.refs,replace:ops=>{ctx.incoming=ops;vm.runInContext('replaceOperationSnapshots(incoming)',ctx);},
		flush:()=>vm.runInContext('flushProjectedMessages()',ctx)};
}

test('actual operation store keeps 1200 historical snapshots raw and publishes a burst only at the UI flush',()=>{
	const h=harness();
	const history=Array.from({length:1200},(_,i)=>({opId:`op-${i}`,opType:'reasoning',displaySeq:i+1,revision:1,status:'running',lifecycle:'active',payload:{text:'start'}}));
	h.replace(ref(history).value); // even a reactive HTTP/state source is unwrapped
	assert.equal(isProxy(h.refs.operationsById.value),false);
	assert.equal(isProxy(h.refs.operationsById.value.get('op-0')),false);
	assert.equal(isProxy(h.refs.operationsById.value.get('op-0').payload),false);
	let paints=0,visible='';
	const runner=effect(()=>{
		paints++;
		const payload=h.refs.operationsById.value.get('op-1199').payload;
		visible=typeof payload.text==='string'?payload.text:payload.textChunks.join('');
	});
	const before=paints;
	try {
		for(let revision=2;revision<=41;revision++){
			const store={operationsById:h.refs.operationsById.value,orderedOpIds:h.refs.orderedOpIds.value,
				revisionByOpId:h.refs.revisionByOpId.value,lastFrameSeq:revision-1};
			assert.equal(applyOperationFrame(store,{opId:'op-1199',opType:'reasoning',action:'delta',revision,frameSeq:revision,payload:{delta:'x'}}),true);
		}
		assert.equal(paints,before,'Map.set must not repaint the full loaded history for each token');
		h.flush();
		assert.equal(paints,before+1);
		assert.equal(visible,'start'+'x'.repeat(40));
		assert.equal(h.refs.operationsById.value.size,1200);
		assert.equal(h.refs.operationsById.value.get('op-0').payload.text,'start');
	} finally {stop(runner);}
});

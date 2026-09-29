import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {ref, watch, effectScope, nextTick} from 'vue';
const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const between = (source, a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a) + a.length));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
function tree(t) {
  const pending=[], timers=new Map(), errors=[], scope=effectScope(); let id=0;
  const c=vm.createContext({ref,watch,query:ref(''),searchRows:ref([]),searchHasMore:ref(false),searchCursor:ref(''),searchArchived:ref(false),archiveUnlocked:ref(false),searchLoading:ref(false),searchGeneration:0,searchResultKey:'',searchTimer:0,
    Api:{conversationTreeSearch(args){const d=deferred();pending.push({args,...d});return d.promise;}},statusAdjustedRow:x=>x,
    apiError:String,ElMessage:{error:e=>errors.push(e)},setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:key=>timers.delete(key)});
  const source=read('./ConversationTree.vue');
  const start=source.includes('function searchRequestKey(')?'function searchRequestKey(':'async function runSearch(';
  scope.run(()=>vm.runInContext(between(source,start,'watch(() => props.draftConversation'),c));
  t.after(()=>scope.stop());
  return {c,pending,errors,async change(value){c.query.value=value;await nextTick();},async flush(){const work=[...timers.values()];timers.clear();return Promise.all(work.map(fn=>fn()));}};
}

test('clearing an in-flight sidebar search clears loading immediately and rejects its late reply', async t => {
  const h=tree(t);await h.change('alpha');const work=h.flush();assert.equal(h.c.searchLoading.value,true);
  await h.change('');await h.flush();assert.equal(h.c.searchLoading.value,false);
  h.pending[0].resolve({items:[{id:'old'}],nextCursor:'old',hasMore:true});await work;
  assert.equal(h.c.searchRows.value.length,0);assert.equal(h.c.searchCursor.value,'');assert.equal(h.c.searchHasMore.value,false);
});
test('query changes discard old pagination before debounce, and current pages keep their order', async t => {
  const h=tree(t);await h.change('alpha');let work=h.flush();h.pending[0].resolve({items:[{id:'a'}],nextCursor:'a-cursor',hasMore:true});await work;
  await h.change('beta');const blocked=h.c.runSearch({append:true});assert.equal(h.pending.length,1);await blocked;
  assert.equal(h.c.searchRows.value.length,0);work=h.flush();assert.equal(h.pending[1].args.cursor,undefined);
  h.pending[1].resolve({items:[{id:'b1'}],nextCursor:'b-cursor',hasMore:true});await work;
  work=h.c.runSearch({append:true});assert.equal(h.pending[2].args.cursor,'b-cursor');
  await h.c.runSearch({append:true});assert.equal(h.pending.length,3);
  h.pending[2].resolve({items:[{id:'b2'}],hasMore:false});await work;
  assert.deepEqual(Array.from(h.c.searchRows.value,x=>x.id),['b1','b2']);
});
test('archive scope changes cannot reuse a prior scope cursor; stale rejection cannot clear new loading', async t => {
  const h=tree(t);h.c.archiveUnlocked.value=true;await h.change('alpha');let work=h.flush();h.pending[0].resolve({items:[{id:'a'}],nextCursor:'old',hasMore:true});await work;
  const old=h.c.runSearch();h.c.searchArchived.value=true;await nextTick();
  assert.equal(h.pending.at(-1).args.archiveUnlocked,1);assert.equal(h.c.searchCursor.value,'');
  h.pending[1].reject(Error('stale'));await old;assert.equal(h.c.searchLoading.value,true);assert.deepEqual(h.errors,[]);
  h.pending[2].resolve({items:[],hasMore:false});await nextTick();await nextTick();assert.equal(h.c.searchLoading.value,false);
});

for (const [file,name,method,start,end] of [
  ['DocsView.vue','docs','docs','async function load()','async function refresh()'],
  ['SecretsView.vue','secrets','secrets','async function load()','async function refresh()'],
  ['MemoryView.vue','entries','entries','async function loadEntries()','async function loadRefData()'],
]) {
  function harness() {
    const pending=[],successes=[],selected=ref([]);let rebuilds=0;
    const c=vm.createContext({alive:true,loadGeneration:0,loading:ref(false),loadError:ref(''),apiError:e=>e.message,showArchived:ref(false),activeCat:ref('memory'),[name]:ref([]),rebuildGroups(){rebuilds++;},clearSelection(){selected.value=[];},loadCategories:async()=>{},loadRefData:async()=>{},ElMessage:{success:s=>successes.push(s)},Api:{[method](...args){const d=deferred();pending.push({args,...d});return d.promise;}}});
    const source=read('../views/'+file);
    vm.runInContext(between(source,start,end),c);
    vm.runInContext(between(source,'async function refresh()','onMounted('),c);
    return {c,pending,selected,successes,load:()=>method==='entries'?c.loadEntries():c.load(),get rebuilds(){return rebuilds;}};
  }
  test(`${file}: only latest category/archive response rebuilds the visible list`, async()=>{
    const h=harness();const first=h.load();h.c.showArchived.value=true;if(name==='entries')h.c.activeCat.value='tools';const second=h.load();
    h.pending[1].resolve({items:[{id:'new-1'},{id:'new-2'}]});await second;
    h.pending[0].resolve({items:[{id:'stale'}]});await first;
    assert.deepEqual(Array.from(h.c[name].value,x=>x.id),['new-1','new-2']);assert.equal(h.rebuilds,1);assert.equal(h.c.loading.value,false);
  });
  test(`${file}: latest failure clears old-scope data and selections; retry restores the chosen scope`,async()=>{
    const h=harness();let work=h.load();h.pending[0].resolve({items:[{id:'old'}]});await work;h.selected.value=['old'];
    h.c.showArchived.value=true;if(name==='entries')h.c.activeCat.value='tools';work=h.load();h.pending[1].reject(Error('latest failed'));
    assert.equal(await work,false);assert.equal(h.c[name].value.length,0);assert.equal(h.selected.value.length,0);assert.equal(h.c.loading.value,false);assert.equal(h.c.loadError.value,'latest failed');
    work=h.load();assert.equal(h.c.loadError.value,'');h.pending[2].resolve({items:[{id:'new-scope'}]});assert.equal(await work,true);
    assert.deepEqual(Array.from(h.c[name].value,x=>x.id),['new-scope']);assert.equal(h.c.loadError.value,'');
    const source=read('../views/'+file);assert.match(source,/v-if="loadError" role="alert"/);assert.match(source,new RegExp(`:disabled="loading" @click="${name==='entries'?'loadEntries':'load'}">重试`));
  });
  test(`${file}: stale failure cannot erase a newer successful result or its error state`,async()=>{
    const h=harness();const old=h.load(),current=h.load();h.pending[1].resolve({items:[{id:'current'}]});await current;
    h.pending[0].reject(Error('stale failed'));assert.equal(await old,false);
    assert.deepEqual(Array.from(h.c[name].value,x=>x.id),['current']);assert.equal(h.c.loadError.value,'');assert.equal(h.rebuilds,1);
  });
  test(`${file}: a failed refresh exposes retry instead of reporting success`,async()=>{
    const h=harness();const work=h.c.refresh();await new Promise(resolve=>setImmediate(resolve));
    h.pending[0].reject(Error('refresh failed'));await work;assert.deepEqual(h.successes,[]);assert.equal(h.c.loadError.value,'refresh failed');
  });
  test(`${file}: old completion cannot stop current loading, and unmount rejects writes`, async()=>{
    const h=harness();const first=h.load(),second=h.load();h.pending[0].resolve({items:[{id:'stale'}]});await first;
    assert.equal(h.c.loading.value,true);assert.equal(h.rebuilds,0);
    h.c.alive=false;h.pending[1].resolve({items:[{id:'unmounted'}]});await second;assert.equal(h.rebuilds,0);
  });
}

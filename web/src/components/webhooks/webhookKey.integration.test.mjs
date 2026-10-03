import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {parse, compileScript} from '@vue/compiler-sfc';
import * as Vue from 'vue';
import {renderToString} from 'vue/server-renderer';
import {Copy, Eye, EyeOff, RefreshCw} from '@lucide/vue';

const descriptor = parse(fs.readFileSync(new URL('./WebhookKey.vue', import.meta.url), 'utf8')).descriptor;
const source = descriptor.scriptSetup.content.replace(/^import .*;\n/gm, '');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };
const flush = async () => { for (let i = 0; i < 6; i++) await Vue.nextTick(); };
const credential = key => ({credential: {key, recoverable: true, hasCredential: true}});
function harness({read = async () => credential('wh_fixture-raw-key'), copy, endpointId = 'E1'} = {}) {
  const props = Vue.reactive({endpointId, revision: 0, busy: false});
  const calls = [], copied = [], cleanup = [], effects = Vue.effectScope();
  const ctx = {...Vue, Copy, Eye, EyeOff, RefreshCw, AbortController, console,
    defineProps: () => props, defineEmits: () => () => {}, onBeforeUnmount: fn => cleanup.push(fn),
    navigator: {clipboard: {writeText: copy || (async text => {copied.push(text);})}},
    Api: {webhookKey: async (id, options) => {calls.push({id, options}); return read(id, options);}},
  };
  vm.createContext(ctx); effects.run(() => vm.runInContext(source, ctx));
  const run = code => vm.runInContext(code, ctx);
  async function html() {
    const all = compileScript(descriptor, {id: 'key-test'}).bindings;
    const names = Object.keys(all).filter(name => all[name] !== 'props');
    const bindings = Vue.proxyRefs({...run(`({${names.join(',')}})`), ...props});
    const draw = Vue.compile(descriptor.template.content);
    const app = Vue.createSSRApp({render() {return draw.call(this, bindings, []);}});
    app.component('ElButton', {setup(_, {slots, attrs}) {return () => Vue.h('button', attrs, slots.default?.());}});
    for (const [name, component] of Object.entries({Copy, Eye, EyeOff, RefreshCw})) app.component(name, component);
    app.config.warnHandler = () => {};
    return renderToString(app);
  }
  return {props, calls, copied, run, html, close() {cleanup.forEach(fn => fn()); effects.stop();}};
}

test('key stays on one row with a masked preview and eye/copy/refresh icons; copying always uses the original', async () => {
  const h = harness(); await flush();
  let html = await h.html();
  assert.match(html, /type="text" value="wh_fixtu\*{11}"/);
  assert.match(html, /aria-label="显示 Key"/); assert.match(html, /aria-label="复制 Key"/);
  assert.match(html, /aria-label="刷新密钥"/);
  assert.equal((html.match(/<button/g) || []).length, 3);
  assert.doesNotMatch(html, /<small|wh-key-heading|轮换…/);
  assert.match(descriptor.styles[0].content, /flex-direction:row;align-items:center;flex-wrap:nowrap/);
  assert.match(html, /<svg/); assert.equal(h.calls.length, 1);
  await h.run('copyKey()');
  h.run('hidden.value = false'); html = await h.html();
  assert.match(html, /type="text" value="wh_fixture-raw-key"/);
  assert.match(html, /aria-label="隐藏 Key"/);
  await h.run('copyKey()');
  assert.deepEqual(h.copied, ['wh_fixture-raw-key', 'wh_fixture-raw-key']);
  assert.equal(h.run('notice.value'), '已复制 Key');
  h.close(); assert.equal(h.run('key.value'), '');
  const reopened = harness(); await flush();
  assert.equal(reopened.run('key.value'), 'wh_fixture-raw-key'); assert.equal(reopened.run('hidden.value'), true);
  reopened.close();
});

test('legacy key shows an explicit unrecoverable explanation, no fake input and no copy action', async () => {
  const h = harness({read: async () => ({credential: {hasCredential: true, recoverable: false, key: null, unavailableReason: 'legacy_not_recoverable'}})});
  await flush(); const html = await h.html();
  assert.match(html, /旧 Key 无法恢复/); assert.match(html, /现有 Key 仍可使用/); assert.match(html, /手动轮换/);
  assert.doesNotMatch(html, /<input|••/);
  assert.match(html, /disabled[^>]*aria-label="复制 Key"/);
  await h.run('copyKey()'); assert.deepEqual(h.copied, []); h.close();
});

test('unsaved endpoint does not request a key; saving its ID enables repeated owner reads', async () => {
  const h = harness({endpointId: null}); await flush();
  assert.equal(h.calls.length, 0); assert.match(await h.html(), /启用后自动生成密钥/);
  assert.doesNotMatch(await h.html(), /<button|<small/);
  h.props.endpointId = 'created'; await flush(); assert.equal(h.run('key.value'), 'wh_fixture-raw-key');
  await h.run('load()'); assert.equal(h.calls.length, 2); h.close();
});

test('rotation refreshes using the existing control revision and ignores older in-flight key reads', async () => {
  const old = deferred(); let reads = 0;
  const h = harness({read: () => ++reads === 1 ? old.promise : Promise.resolve(credential('wh_rotated'))});
  h.props.revision++; await flush();
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.run('key.value'), 'wh_rotated');
  old.resolve(credential('wh_old-grace-key')); await flush();
  assert.equal(h.run('key.value'), 'wh_rotated'); await h.run('copyKey()'); assert.deepEqual(h.copied, ['wh_rotated']);
  h.close();
});

test('changing endpoint clears the earlier key during load; unmount aborts and late reads cannot restore plaintext', async () => {
  const pending = deferred(); const h = harness({read: id => id === 'E1' ? Promise.resolve(credential('wh_first')) : pending.promise});
  await flush(); h.props.endpointId = 'E2'; await Vue.nextTick();
  assert.equal(h.run('key.value'), ''); assert.doesNotMatch(await h.html(), /wh_first/);
  h.close(); assert.equal(h.calls[1].options.signal.aborted, true);
  pending.resolve(credential('wh_second')); await flush(); assert.equal(h.run('key.value'), '');
});

test('read/decryption failure is retryable and never rotates a credential automatically', async () => {
  let fail = true;
  const h = harness({read: async () => {if (fail) throw {response: {data: {code: 'credential_unavailable'}}}; return credential('wh_reloaded');}});
  await flush(); assert.match(h.run('error.value'), /无法解密.*不会自动轮换/); assert.equal(h.run('key.value'), '');
  await h.run('copyKey()'); assert.equal(h.copied.length, 0);
  fail = false; await h.run('load()'); assert.equal(h.run('error.value'), ''); assert.equal(h.run('key.value'), 'wh_reloaded'); h.close();
});

test('clipboard denial exposes and selects the original key for manual copy without claiming success', async () => {
  let selected = 0; const h = harness({copy: async () => {throw new Error('denied');}}); await flush();
  h.run('input').value = {select() {selected++;}}; h.run('hidden.value = true');
  await h.run('copyKey()'); assert.equal(h.run('hidden.value'), false); assert.equal(selected, 1);
  assert.match(h.run('notice.value'), /复制失败/); assert.doesNotMatch(h.run('notice.value'), /已复制/); h.close();
});

test('Web-only key API uses the dedicated endpoint, encoded identity and abort signal', async () => {
  const source = fs.readFileSync(new URL('../../api.js', import.meta.url), 'utf8');
  const method = source.match(/^  webhookKey: (.+),$/m)[1];
  const calls = [], signal = new AbortController().signal;
  const ctx = {api: {get: async (...args) => {calls.push(args); return {data: credential('fixture')};}}, unwrap: result => result.data};
  vm.createContext(ctx); const call = vm.runInContext(`(${method})`, ctx);
  assert.equal((await call('E/1', {signal})).credential.key, 'fixture');
  assert.equal(calls[0][0], '/webhooks/E%2F1/credentials/current'); assert.equal(calls[0][1].signal, signal);
});

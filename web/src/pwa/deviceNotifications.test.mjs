import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as Vue from 'vue';
import {renderToString} from 'vue/server-renderer';
import {parse, compileScript, compileStyle, compileTemplate} from '@vue/compiler-sfc';
import postcss from 'postcss';

const {descriptor} = parse(readFileSync(new URL('./DeviceNotifications.vue', import.meta.url), 'utf8'));
const css = postcss.parse(descriptor.styles[0].content);
function declarations(selector, width = 1440) {
  const result = {};
  css.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    if (rule.parent.type === 'atrule' && rule.parent.params === '(max-width: 760px)' && width > 760) return;
    rule.walkDecls(d => {result[d.prop] = d.value;});
  });
  return result;
}
const walk = node => [node, ...(Array.isArray(node?.children) ? node.children.flatMap(walk) : [])];
async function component({enabled = false, supported = true, busy = false, readStatus} = {}) {
  const calls = [];
  const state = {supported, enabled, permission: 'granted'};
  const context = vm.createContext({...Vue, onMounted() {}, onBeforeUnmount() {}, window: {},
    pushSupport: () => state,
    createPushClient: () => ({
      async status() {return readStatus ? readStatus() : state;},
      async enable() {calls.push('enable'); return {...state, enabled: true};},
      async disable() {calls.push('disable'); return {...state, enabled: false};},
      async test() {calls.push('test');},
    }),
  });
  vm.runInContext(descriptor.scriptSetup.content.replace(/^import .*;\n/gm, ''), context);
  context.initial = {...state};
  context.initialBusy = busy;
  vm.runInContext('status.value = initial; busy.value = initialBusy;', context);
  const scope = vm.runInContext('({status, busy, message, failed, run})', context);
  const compiled = Vue.compile(descriptor.template.content);
  let tree;
  const renderScope = Vue.proxyRefs(scope);
  const app = Vue.createSSRApp({render() {tree = compiled.call(this, renderScope, []); return tree;}});
  app.config.warnHandler = message => assert.fail(message);
  app.component('Bell', {render: () => Vue.h('svg')});
  const html = await renderToString(app);
  return {html, calls, context, buttons: walk(tree).filter(node => node?.type === 'button')};
}

for (const action of ['enable', 'disable']) {
  for (const staleError of [false, true]) {
    test(`late focus ${staleError ? 'failure' : 'status'} cannot overwrite successful ${action}`, async () => {
      let resolve, reject;
      const pending = new Promise((yes, no) => {resolve = yes; reject = no;});
      const view = await component({enabled: action === 'disable', readStatus: () => pending});
      const oldRefresh = vm.runInContext('refresh()', view.context);
      await vm.runInContext(`run('${action}')`, view.context);
      const successMessage = vm.runInContext('message.value', view.context);
      if (staleError) reject(new Error('stale status error'));
      else resolve({supported: true, enabled: action === 'disable'});
      await oldRefresh;
      assert.equal(vm.runInContext('status.value.enabled', view.context), action === 'enable');
      assert.equal(vm.runInContext('message.value', view.context), successMessage);
      assert.equal(vm.runInContext('failed.value', view.context), false);
      assert.equal(vm.runInContext('busy.value', view.context), false);
    });
  }
}

test('a newer focus read wins when status queries finish out of order', async () => {
  const pending = [];
  const view = await component({readStatus: () => new Promise(resolve => pending.push(resolve))});
  const old = vm.runInContext('refresh()', view.context);
  const fresh = vm.runInContext('refresh()', view.context);
  pending[1]({supported: true, enabled: true});
  await fresh;
  pending[0]({supported: true, enabled: false});
  await old;
  assert.equal(vm.runInContext('status.value.enabled', view.context), true);
});

test('device card owns compiled button styles instead of relying on parent scoped classes', () => {
  const script = compileScript(descriptor, {id: 'device-notifications'});
  assert.deepEqual(compileTemplate({source: descriptor.template.content, filename: 'DeviceNotifications.vue', id: 'device-notifications', compilerOptions: {bindingMetadata: script.bindings}}).errors, []);
  const result = compileStyle({source: descriptor.styles[0].content, id: 'data-v-device-notifications', scoped: true});
  assert.deepEqual(result.errors, []);
  assert.match(result.code, /\.device-notifications__button\[data-v-device-notifications\]/);
  const button = declarations('.device-notifications__button');
  assert.equal(button.cursor, 'pointer');
  assert.equal(button['font-size'], '12px');
  assert.match(button.border, /1px solid/);
  assert.equal(declarations('.device-notifications__button.is-primary').background, 'var(--ob-blue)');
  assert.equal(declarations('.device-notifications__button.is-primary').color, 'var(--ob-text-inverse)');
  assert.equal(declarations('.device-notifications__button:focus-visible').outline, '2px solid var(--ob-blue)');
  assert.equal(declarations('.device-notifications').margin, '0 0 14px');
  assert.equal(declarations('.device-notifications').background, 'var(--ob-surface)');
  for (const width of [320, 390, 760]) {
    assert.equal(declarations('.device-notifications__main', width)['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(declarations('.device-notifications__button', width)['min-height'], '40px');
    assert.equal(declarations('.device-notifications', width)['border-radius'], '16px');
  }
});

test('rendered enable, disable and test buttons keep their actual handlers and primary/secondary emphasis', async () => {
  const off = await component();
  assert.equal(off.buttons.length, 1);
  assert.match(off.buttons[0].props.class, /is-primary/);
  await off.buttons[0].props.onClick();
  assert.deepEqual(off.calls, ['enable']);
  const on = await component({enabled: true});
  assert.equal(on.buttons.length, 2);
  assert.doesNotMatch(on.buttons[0].props.class, /is-primary/);
  assert.match(on.buttons[1].props.class, /is-primary/);
  await on.buttons[1].props.onClick();
  await on.buttons[0].props.onClick();
  assert.deepEqual(on.calls, ['test', 'disable']);
  assert.match(on.html, /本设备系统通知/);
  assert.match(on.html, /is-enabled/);
});

test('busy controls cannot submit again and unsupported devices retain their explanation without controls', async () => {
  const busy = await component({enabled: true, busy: true});
  assert.ok(busy.buttons.every(button => button.props.disabled));
  await busy.buttons[0].props.onClick();
  assert.deepEqual(busy.calls, []);
  assert.match(busy.html, /处理中/);
  const unsupported = await component({supported: false});
  assert.equal(unsupported.buttons.length, 0);
  assert.match(unsupported.html, /暂不支持/);
});

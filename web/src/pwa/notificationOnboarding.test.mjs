import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as Vue from 'vue';
import {parse, compileScript, compileTemplate, compileStyle} from '@vue/compiler-sfc';
import {createPushClient} from './pushClient.js';
import {createNotificationOnboarding, NOTIFICATION_PROMPT_KEY, NOTIFICATION_SETTINGS_PATH} from './notificationOnboarding.js';

function fixture({storage = new Map(), supported = true, enabled = false, enableError, hidden = false} = {}) {
  const state = {open: false, busy: false, phase: 'offer', error: ''};
  const calls = [], messages = [];
  const win = {
    document: {visibilityState: hidden ? 'hidden' : 'visible'},
    Notification: {permission: 'default'},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
  };
  const client = {
    async status() { calls.push('status'); return {supported, enabled}; },
    async enable() { calls.push('enable'); if (enableError) throw enableError; return {enabled: true}; },
  };
  const controller = createNotificationOnboarding(win, state, {client, notify: text => messages.push(text)});
  return {win, state, client, controller, calls, messages, storage, choice: () => JSON.parse(storage.get(NOTIFICATION_PROMPT_KEY)).choice};
}

test('first visible startup invites once, but never requests system permission automatically', async () => {
  const f = fixture();
  await Promise.all([f.controller.start(), f.controller.start()]);
  assert.equal(f.state.open, true);
  assert.equal(f.choice(), 'shown');
  assert.deepEqual(f.calls, ['status']);
  const reload = fixture({storage: f.storage});
  await reload.controller.start();
  assert.equal(reload.state.open, false, 'even a refresh while the invitation is open must not repeat it');
  assert.deepEqual(reload.calls, []);
});

test('cancel records dismissal and explicitly explains the new manual settings path', async () => {
  const f = fixture();
  await f.controller.start();
  f.controller.dismiss();
  assert.equal(f.choice(), 'dismissed');
  assert.equal(f.state.open, false);
  assert.ok(f.messages[0].includes(NOTIFICATION_SETTINGS_PATH));
  assert.match(f.messages[0], /不会再次自动询问/);
  assert.deepEqual(f.calls, ['status']);
  await fixture({storage: f.storage}).controller.start();
  await f.client.enable(); // The invitation marker must not disable manual opt-in.
  assert.deepEqual(f.calls, ['status', 'enable']);
});

test('accepted invitation persists before the synchronous enable call and never repeats after reload', async () => {
  const f = fixture();
  f.client.enable = async () => {
    assert.equal(f.choice(), 'enable');
    f.calls.push('enable');
    return {enabled: true};
  };
  await f.controller.start();
  const task = f.controller.enable();
  assert.deepEqual(f.calls, ['status', 'enable'], 'enable must run before yielding the button gesture');
  assert.equal(f.state.busy, true);
  f.controller.dismiss();
  assert.equal(f.state.open, true, 'cannot close while subscribing');
  await task;
  assert.equal(f.choice(), 'enabled');
  assert.equal(f.state.phase, 'enabled');
  f.controller.dismiss();
  assert.deepEqual(f.messages, []);
  const reload = fixture({storage: f.storage});
  await reload.controller.start();
  assert.equal(reload.state.open, false);
});

for (const permission of ['denied', 'default', 'granted']) {
  test(`permission ${permission}: refusal, dismissal or subscription failure is also one-shot`, async () => {
    const f = fixture({enableError: new Error('notification unavailable')});
    f.win.Notification.permission = permission;
    await f.controller.start();
    await f.controller.enable();
    assert.equal(f.state.phase, 'failed');
    assert.equal(f.state.error, 'notification unavailable');
    assert.equal(f.choice(), permission === 'denied' ? 'denied' : 'failed');
    f.controller.dismiss();
    const reload = fixture({storage: f.storage});
    await reload.controller.start();
    assert.equal(reload.state.open, false);
  });
}

test('already-enabled devices are not asked; the reminder is not repeated after disabling later', async () => {
  const f = fixture({enabled: true});
  await f.controller.start();
  assert.equal(f.state.open, false);
  assert.equal(f.choice(), 'already-enabled');
  const later = fixture({storage: f.storage});
  await later.controller.start();
  assert.equal(later.state.open, false);
});

test('unsupported or hidden contexts wait until notifications can actually be offered', async () => {
  const unsupported = fixture({supported: false});
  await unsupported.controller.start();
  assert.equal(unsupported.storage.size, 0);
  const installed = fixture({storage: unsupported.storage});
  await installed.controller.start();
  assert.equal(installed.state.open, true);
  const hidden = fixture({hidden: true});
  await hidden.controller.start();
  assert.equal(hidden.storage.size, 0);
  assert.deepEqual(hidden.calls, []);
  hidden.win.document.visibilityState = 'visible';
  await hidden.controller.start();
  assert.equal(hidden.state.open, true);
});

test('status failure and component disposal do not consume an unseen invitation', async () => {
  const f = fixture();
  f.client.status = async () => { throw new Error('offline'); };
  await f.controller.start();
  assert.equal(f.storage.size, 0);
  f.client.status = async () => { f.controller.dispose(); return {supported: true}; };
  await f.controller.start();
  assert.equal(f.storage.size, 0);
  assert.equal(f.state.open, false);
});

test('storage restrictions cannot crash startup or cause an unrecordable recurring prompt', async () => {
  for (const method of ['getItem', 'setItem']) {
    const f = fixture();
    f.win.localStorage[method] = () => { throw new Error('storage blocked'); };
    await f.controller.start();
    assert.equal(f.state.open, false);
  }
});

test('a choice in another tab while checking status prevents another invitation', async () => {
  const f = fixture();
  f.client.status = async () => {
    f.storage.set(NOTIFICATION_PROMPT_KEY, JSON.stringify({choice: 'dismissed'}));
    return {supported: true};
  };
  await f.controller.start();
  assert.equal(f.state.open, false);
});

for (const [name, agent, standalone] of [
  ['PC browser', 'Chrome', false],
  ['Android Chrome application', 'Android Chrome', true],
  ['iOS PWA', 'iPhone', true],
]) {
  test(`${name}: real push client requests permission in the click, then registers and subscribes`, async () => {
    const f = fixture();
    const sequence = [];
    const registration = {active: {state: 'activated'}, pushManager: {
      async getSubscription() { return null; },
      async subscribe() { sequence.push('subscribe'); return {toJSON: () => ({endpoint: 'device'}), async unsubscribe() {}}; },
    }};
    Object.assign(f.win, {
      isSecureContext: true, location: {protocol: 'https:'}, PushManager: class {}, Event,
      dispatchEvent() {},
      Notification: {permission: 'default', async requestPermission() {sequence.push('permission'); return 'granted';}},
      navigator: {userAgent: agent, standalone, serviceWorker: {
        async getRegistration() { return undefined; },
        async register() {sequence.push('register'); return registration;},
      }},
    });
    const client = createPushClient(f.win, async path => {
      sequence.push(path);
      return path === 'key' ? {publicKey: Buffer.alloc(65, 4).toString('base64url')} : {enabled: true};
    });
    const controller = createNotificationOnboarding(f.win, f.state, {client});
    await controller.start();
    assert.deepEqual(sequence, []);
    assert.equal(f.state.open, true);
    const pending = controller.enable();
    assert.deepEqual(sequence, ['permission']);
    await pending;
    assert.deepEqual(sequence, ['permission', 'key', 'register', 'subscribe', 'subscription']);
    assert.equal(f.state.phase, 'enabled');
  });
}

test('real onboarding component installs and removes visibility handling, with all close paths sharing dismissal', async () => {
  const source = readFileSync(new URL('./NotificationOnboarding.vue', import.meta.url), 'utf8');
  const {descriptor} = parse(source);
  const script = compileScript(descriptor, {id: 'notification-onboarding'});
  assert.deepEqual(compileTemplate({source: descriptor.template.content, filename: 'NotificationOnboarding.vue', id: 'notification-onboarding', compilerOptions: {bindingMetadata: script.bindings}}).errors, []);
  for (const style of descriptor.styles) assert.deepEqual(compileStyle({source: style.content, id: 'notification-onboarding', scoped: style.scoped}).errors, []);
  const f = fixture();
  let mounted, unmount;
  const listeners = new Map();
  const context = vm.createContext({...Vue,
    onMounted: fn => {mounted = fn;}, onBeforeUnmount: fn => {unmount = fn;},
    window: f.win,
    document: {addEventListener: (event, fn) => listeners.set(event, fn), removeEventListener: event => listeners.delete(event)},
    ElMessage: {info: options => f.messages.push(options.message)},
    createNotificationOnboarding: (win, state, options) => createNotificationOnboarding(win, state, {...options, client: f.client}),
  });
  vm.runInContext(descriptor.scriptSetup.content.replace(/^import .*;\n/gm, ''), context);
  mounted();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('state.open', context), true);
  assert.ok(listeners.has('visibilitychange'));
  vm.runInContext('visibilityChanged(false)', context);
  assert.equal(f.choice(), 'dismissed');
  assert.ok(f.messages[0].includes(NOTIFICATION_SETTINGS_PATH));
  unmount();
  assert.equal(listeners.size, 0);
  assert.match(descriptor.template.content, /@click="onboarding\.enable\(\)"/);
  assert.match(descriptor.template.content, /@update:model-value="visibilityChanged"/);
  const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8');
  assert.match(app, /<LoginView v-if="isLoginPath"\s*\/>\s*<div v-else[^>]*>\s*<NotificationOnboarding\s*\/>/);
});

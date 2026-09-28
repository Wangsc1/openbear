import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createPushClient, decodePushKey, installPushNavigation, installPushPresence, pushSupport, waitForPushWorker} from './pushClient.js';

const publicKey = Buffer.alloc(65, 4).toString('base64url');
function browser({permission = 'default', existing = false} = {}) {
  const calls = [], requests = [];
  const listeners = new Map();
  const sub = {endpoint: 'https://web.push.apple.com/device', options: {}, toJSON() {return {endpoint: this.endpoint, keys: {}};}, async unsubscribe() {calls.push('unsubscribe'); registration.subscription = null; return true;}};
  const registration = {active: {state: 'activated'}, subscription: existing ? sub : null, async update() {}, pushManager: {
    async getSubscription() { return registration.subscription; },
    async subscribe(options) {calls.push(['subscribe', options]); registration.subscription = sub; return sub;},
  }};
  const win = {
    isSecureContext: true, location: {origin: 'https://bear.test', protocol: 'https:', href: 'https://bear.test/chat'},
    Notification: {permission, requestPermission() {calls.push('permission'); return Promise.resolve(this.permission === 'denied' ? 'denied' : 'granted');}},
    PushManager: class {}, Event,
    navigator: {userAgent: 'Chrome', serviceWorker: {
      async getRegistration() {return existing || registration.subscription ? registration : undefined;},
      async register(path, options) {calls.push(['register', path, options]); return registration;},
      addEventListener(type, cb) {listeners.set(type, cb);}, removeEventListener(type) {listeners.delete(type);},
    }},
    document: {visibilityState: 'visible', hasFocus: () => true, addEventListener(type, cb) {listeners.set(type, cb);}, removeEventListener(type) {listeners.delete(type);}},
    addEventListener(type, cb) {listeners.set(type, cb);}, removeEventListener(type) {listeners.delete(type);},
    dispatchEvent(event) {listeners.get(event.type)?.(event);}, setInterval(fn) {win.tick = fn; return 1;}, clearInterval() {},
  };
  async function request(path, body, method) {requests.push({path, body, method}); return path === 'key' ? {ok: true, publicKey} : {ok: true, enabled: true};}
  return {win, calls, requests, request, registration, sub, listeners};
}

test('capability explains HTTP, old platforms and iOS home-screen requirement', () => {
  const {win} = browser();
  assert.equal(pushSupport(win).supported, true);
  win.isSecureContext = false;
  assert.match(pushSupport(win).reason, /HTTPS/);
  win.isSecureContext = true;
  win.navigator.userAgent = 'iPhone';
  assert.match(pushSupport(win).reason, /主屏幕/);
  win.navigator.standalone = true;
  assert.equal(pushSupport(win).supported, true);
  delete win.PushManager;
  assert.match(pushSupport(win).reason, /不支持/);
});

test('status does not register worker or request permission on a new device', async () => {
  const b = browser();
  const state = await createPushClient(b.win, b.request).status();
  assert.equal(state.enabled, false);
  assert.deepEqual(b.calls, []);
  assert.deepEqual(b.requests, []);
});

test('enable requests permission in the original click before network awaits, then saves subscription', async () => {
  const b = browser();
  const task = createPushClient(b.win, b.request).enable();
  assert.deepEqual(b.calls, ['permission']);
  assert.deepEqual(b.requests, []);
  const state = await task;
  assert.equal(state.enabled, true);
  assert.equal(b.calls[1][1], '/openbear-push-sw.js');
  assert.equal(b.calls[2][1].userVisibleOnly, true);
  assert.deepEqual([...b.calls[2][1].applicationServerKey], [...decodePushKey(publicKey)]);
  assert.deepEqual(b.requests.map(r => r.path), ['key', 'subscription']);
});

test('denied permission never registers or saves', async () => {
  const b = browser({permission: 'denied'});
  await assert.rejects(createPushClient(b.win, b.request).enable(), /设置/);
  assert.deepEqual(b.calls, ['permission']);
  assert.deepEqual(b.requests, []);
});

test('server save failure rolls back a newly created browser subscription', async () => {
  const b = browser();
  const request = (path, ...args) => path === 'subscription' ? Promise.reject(new Error('offline')) : b.request(path, ...args);
  await assert.rejects(createPushClient(b.win, request).enable(), /offline/);
  assert.equal(b.calls.at(-1), 'unsubscribe');
});

test('disable deletes the server subscription before browser unsubscribe; test is device-specific', async () => {
  const b = browser({existing: true, permission: 'granted'});
  const client = createPushClient(b.win, b.request);
  await client.test();
  assert.deepEqual(b.requests[0], {path: 'test', body: {endpoint: b.sub.endpoint}, method: undefined});
  await client.disable();
  assert.equal(b.requests[1].method, 'DELETE');
  assert.equal(b.calls.at(-1), 'unsubscribe');
});

test('worker activation has a bounded failure, not an indefinitely busy UI', async () => {
  const worker = new EventTarget(); worker.state = 'installing';
  await assert.rejects(waitForPushWorker({installing: worker}, 5), /超时/);
  worker.state = 'redundant';
  await assert.rejects(waitForPushWorker({installing: worker}), /失败/);
});

test('notification navigation only accepts same-origin app destinations', () => {
  const b = browser(), routes = [];
  const stop = installPushNavigation(b.win, url => routes.push(url));
  const send = url => b.listeners.get('message')({data: {type: 'openbear:notification-open', url}});
  send('https://evil.test/chat'); send('/api/auth/session'); send('/chat?id=conv');
  assert.deepEqual(routes, ['/chat?id=conv']);
  stop(); assert.equal(b.listeners.has('message'), false);
});

test('foreground presence is limited to focused visible device and cleaned up', async () => {
  const b = browser({existing: true});
  const presence = installPushPresence(b.win, () => 'conv', b.request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.requests.at(-1).body.conversationUuid, 'conv');
  b.win.document.visibilityState = 'hidden';
  b.listeners.get('visibilitychange')();
  assert.equal(b.requests.at(-1).body.conversationUuid, '');
  const count = b.requests.length;
  b.win.tick(); assert.equal(b.requests.length, count);
  presence.stop();
  assert.equal(b.listeners.has('focus'), false);
});

function serviceWorker() {
  const handlers = {}, notices = [], opened = [], messages = [];
  const existing = {url: 'https://bear.test/chat?id=old', async focus() {messages.push('focus');}, postMessage(data) {messages.push(data);}};
  const self = {location: {origin: 'https://bear.test'}, addEventListener(type, handler) {handlers[type] = handler;},
    registration: {async showNotification(title, options) {notices.push({title, options});}},
    clients: {async matchAll() {return [existing];}, async openWindow(url) {opened.push(url);}},
  };
  vm.runInNewContext(readFileSync(new URL('../../public/openbear-push-sw.js', import.meta.url), 'utf8'), {self, URL});
  async function event(type, data) {let work; handlers[type]({...data, waitUntil(promise) {work = promise;}}); await work;}
  return {handlers, notices, opened, messages, event, existing};
}

test('push worker displays user-visible notification and never intercepts fetch/offline traffic', async () => {
  const w = serviceWorker();
  assert.equal(w.handlers.fetch, undefined);
  await w.event('push', {data: {json: () => ({body: '任务已完成', conversationUuid: 'a&b', tag: 'one'})}});
  assert.equal(w.notices[0].options.data.url, '/chat?id=a%26b');
  assert.equal(w.notices[0].options.body, '任务已完成');
});

test('notification click reuses the current app without navigating/reloading away from drafts', async () => {
  const w = serviceWorker();
  let closed = false;
  await w.event('notificationclick', {notification: {close() {closed = true;}, data: {url: '/chat?id=new'}}});
  assert.equal(closed, true);
  assert.equal(w.messages[0].url, 'https://bear.test/chat?id=new');
  assert.equal(w.messages[1], 'focus');
  assert.deepEqual(w.opened, []);
});

test('notification click rejects external destinations and opens app when no reusable client exists', async () => {
  const w = serviceWorker();
  w.existing.url = 'https://bear.test/login';
  await w.event('notificationclick', {notification: {close() {}, data: {url: 'https://evil.test/steal'}}});
  assert.deepEqual(w.opened, ['https://bear.test/chat']);
});

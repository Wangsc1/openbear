// A context belongs to this document, never to local/sessionStorage. Bootstrap
// once, before importing business views. A revoked document can never rebind.
export const pageSession = {initialized: false, mode: '', instanceId: '', username: '', contextToken: '', blocked: false};
const cleanups = new Set(), sockets = new Set();
let abort = new AbortController(), win, channel, checking, initializing;
const CHANGED = 'openbear:gateway-session-changed';
export function isGateway() { return pageSession.mode === 'gateway'; }
export function onSessionEnd(fn) { cleanups.add(fn); return () => cleanups.delete(fn); }
export function sessionError() { return new Error('当前页面登录已失效或账号已切换，请从登录页重新进入。'); }
export function assertSession() {
  if (isGateway() && (pageSession.blocked || !pageSession.contextToken)) throw sessionError();
}
function protectedUrl(value) {
  try {
    const url = new URL(value, win?.location?.origin || globalThis.location?.origin);
    const origin = new URL(win?.location?.origin || globalThis.location?.origin);
    const same = url.host === origin.host && (url.protocol === origin.protocol || url.protocol === (origin.protocol === 'https:' ? 'wss:' : 'ws:'));
    return same && /^\/(api|files|uploads|media)(\/|$)/.test(url.pathname) ? url : null;
  } catch { return null; }
}
export function contextResourceUrl(value) {
  if (!value || !isGateway()) return value;
  const url = protectedUrl(value);
  if (!url) return value; // Never send the page binding to another origin.
  if (pageSession.blocked || !pageSession.contextToken) return '';
  const prior = url.searchParams.get('_ob_ctx');
  if (prior && prior !== pageSession.contextToken) return '';
  url.searchParams.set('_ob_ctx', pageSession.contextToken);
  return url.href;
}
export function userStorage(storage) {
  if (!isGateway()) return storage;
  const prefix = `openbear.gateway.${encodeURIComponent(pageSession.instanceId)}.`;
  return {
    getItem(key) { return pageSession.blocked || !pageSession.instanceId ? null : storage.getItem(prefix + key); },
    setItem(key, value) { if (!pageSession.blocked && pageSession.instanceId) storage.setItem(prefix + key, value); },
    removeItem(key) { if (!pageSession.blocked && pageSession.instanceId) storage.removeItem(prefix + key); },
  };
}
export function userDatabaseName(name) { return isGateway() ? `${name}.gateway.${encodeURIComponent(pageSession.instanceId)}` : name; }
function clearOwnStorage() {
  if (!pageSession.instanceId) return;
  const prefix = `openbear.gateway.${encodeURIComponent(pageSession.instanceId)}.`;
  for (const name of ['localStorage', 'sessionStorage']) {
    try { const storage = win[name]; for (let i = storage.length - 1; i >= 0; i--) { const key = storage.key(i); if (key?.startsWith(prefix)) storage.removeItem(key); } } catch {}
  }
}
export function announceSessionChange() {
  if (!isGateway() || !win) return;
  try { channel?.postMessage('changed'); } catch {}
  try { win.localStorage.setItem(CHANGED, `${Date.now()}:${Math.random()}`); win.localStorage.removeItem(CHANGED); } catch {}
}
export function endPageSession({broadcast = false, reason = 'changed'} = {}) {
  if (!isGateway() || pageSession.blocked) return;
  pageSession.blocked = true;
  abort.abort();
  for (const socket of sockets) { try { socket.close(1000, 'session ended'); } catch {} }
  sockets.clear();
  clearOwnStorage();
  for (const cleanup of cleanups) { try { Promise.resolve(cleanup()).catch(() => {}); } catch {} }
  if (broadcast) announceSessionChange();
  pageSession.contextToken = '';
  win?.dispatchEvent(new win.CustomEvent('openbear:session-ended', {detail: {reason}}));
}
export function requestBinding(signal) {
  assertSession();
  if (!isGateway()) return {signal, release() {}};
  const controller = new AbortController();
  const cancel = () => controller.abort();
  abort.signal.addEventListener('abort', cancel, {once: true});
  signal?.addEventListener('abort', cancel, {once: true});
  if (signal?.aborted || abort.signal.aborted) controller.abort();
  return {signal: controller.signal, release() { abort.signal.removeEventListener('abort', cancel); signal?.removeEventListener('abort', cancel); }};
}
export function checkSessionResponse(status, data) {
  if (isGateway() && (status === 401 || status === 409 && data?.error === 'session_context_changed')) endPageSession();
}
export async function contextFetch(input, options = {}) {
  if (!isGateway() || !protectedUrl(typeof input === 'string' || input instanceof URL ? input : input.url)) return fetch(input, options);
  const incoming = protectedUrl(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (incoming?.searchParams.has('_ob_ctx') && incoming.searchParams.get('_ob_ctx') !== pageSession.contextToken) throw sessionError();
  const binding = requestBinding(options.signal || input?.signal);
  const headers = new Headers(options.headers || input?.headers);
  headers.set('X-OpenBear-Context', pageSession.contextToken);
  try {
    const response = await fetch(input, {...options, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: binding.signal});
    let data;
    if (response.status === 409) { try { data = await response.clone().json(); } catch {} }
    checkSessionResponse(response.status, data);
    assertSession();
    // Release on caller completion through a wrapped stream, not at headers:
    // session cancellation must also stop a response being consumed slowly.
    if (!response.body) { binding.release(); return response; }
    const reader = response.body.getReader();
    const stream = new ReadableStream({async pull(controller) { try { const part = await reader.read(); if (part.done) { binding.release(); controller.close(); } else controller.enqueue(part.value); } catch (e) { binding.release(); controller.error(e); } }, cancel(reason) { binding.release(); return reader.cancel(reason); }});
    return new Response(stream, {status: response.status, statusText: response.statusText, headers: response.headers});
  } catch (error) { binding.release(); throw error; }
}
export async function validatePageSession() {
  if (!isGateway() || !pageSession.contextToken || pageSession.blocked) return false;
  if (checking) return checking;
  checking = contextFetch('/api/auth/session').then(async response => {
    const data = await response.json();
    if (data.instanceId !== pageSession.instanceId || data.contextToken !== pageSession.contextToken) { endPageSession(); return false; }
    return true;
  }).catch(() => false).finally(() => { checking = null; });
  return checking;
}
export function contextWebSocket(url, protocols) {
  assertSession();
  const socket = protocols === undefined ? new WebSocket(contextResourceUrl(url)) : new WebSocket(contextResourceUrl(url), protocols);
  if (isGateway()) {
    sockets.add(socket);
    socket.addEventListener('close', () => { sockets.delete(socket); void validatePageSession(); }, {once: true});
  }
  return socket;
}
export function notificationInstanceMatches(target) {
  if (!isGateway()) return true;
  try { return new URL(target, win.location.origin).searchParams.get('_ob_instance') === pageSession.instanceId && !pageSession.blocked; } catch { return false; }
}
export function initializePageSession(browser = window) {
  if (pageSession.initialized || pageSession.blocked) return Promise.resolve(pageSession);
  if (!initializing) initializing = initializeOnce(browser).finally(() => { initializing = null; });
  return initializing;
}
async function neutralizePreviousPush(browser) {
  try {
    const owner = browser.localStorage.getItem('openbear.gateway.push-owner');
    if (!owner || owner === pageSession.instanceId) return;
    const registration = await browser.navigator.serviceWorker?.getRegistration('/');
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
    if (browser.localStorage.getItem('openbear.gateway.push-owner') === owner) {
      browser.localStorage.removeItem('openbear.gateway.push-owner');
      registration?.active?.postMessage({type:'openbear:push-boundary',gateway:true,instanceId:''});
    }
  } catch { /* Native capabilities may be unavailable; never block HTTP login. */ }
}
// The serving process writes the mode into index.html; an untouched marker
// (dev server, old backend) is the controller, so loading needs no request.
export function injectedMode(browser = globalThis) {
  const value = browser.__OPENBEAR_AUTH_MODE__;
  return ['controller', 'managed', 'gateway'].includes(value) ? value : 'controller';
}
async function initializeOnce(browser) {
  win = browser;
  const bootstrapFetch = browser.fetch.bind(browser);
  const mode = injectedMode(browser);
  pageSession.mode = mode;
  if (mode === 'gateway') {
    const response = await bootstrapFetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store', redirect: 'error'});
    if (response.ok) {
      const session = await response.json();
      if (session.mode !== 'gateway' || !session.instanceId || !session.contextToken) throw new Error('登录会话不完整，请重新登录。');
      Object.assign(pageSession, {instanceId: session.instanceId, username: session.username || '', contextToken: session.contextToken});
      const expected = new URL(browser.location.href).searchParams.get('_ob_instance');
      if (expected && expected !== session.instanceId) endPageSession({reason: 'notification'});
    } else if (response.status !== 401) throw new Error('无法确认当前账号，请重试。');
    else if (browser.location.pathname !== '/login') { browser.location.replace('/login'); return pageSession; }
    await neutralizePreviousPush(browser);
    try { channel = new browser.BroadcastChannel(CHANGED); channel.onmessage = () => { if (pageSession.contextToken) endPageSession(); }; } catch {}
    browser.addEventListener('storage', event => { if (event.key === CHANGED && event.newValue && pageSession.contextToken) endPageSession(); });
    browser.addEventListener('focus', () => void validatePageSession());
    browser.addEventListener('pageshow', () => void validatePageSession());
    browser.document.addEventListener('visibilitychange', () => { if (browser.document.visibilityState === 'visible') void validatePageSession(); });
    // Resource loads cannot inspect an HTTP status. Revalidate the OLD binding
    // on same-origin image/media errors; never bootstrap a replacement identity.
    browser.addEventListener('error', event => { if (protectedUrl(event.target?.currentSrc || event.target?.src || '')) void validatePageSession(); }, true);
  }
  pageSession.initialized = true;
  return pageSession;
}

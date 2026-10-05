import {installationEnvironment} from "./install.js";
import {notificationTarget} from "../loginRedirect.js";

const PUSH_CHANGED = "openbear:push-changed";
const pageIds = new WeakMap();
function pageId(win) {
  // Memory belongs to this document, unlike sessionStorage copied by window.open.
  if (!pageIds.has(win)) {
    const id = win.crypto.randomUUID?.() || Array.from(win.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    pageIds.set(win, id);
  }
  return pageIds.get(win);
}

function notifyPushChanged(win) {
  win.dispatchEvent(new win.Event(PUSH_CHANGED));
  try {
    const channel = new win.BroadcastChannel(PUSH_CHANGED);
    channel.postMessage(PUSH_CHANGED);
    channel.close();
  } catch {
    // Older engines may lack BroadcastChannel. Do not store endpoints or keys.
    try { win.localStorage.setItem(PUSH_CHANGED, `${Date.now()}:${Math.random()}`); } catch { /* Focus also re-reads the subscription. */ }
  }
}

export function pushSupport(win) {
  const env = installationEnvironment(win);
  if (!env.secure) return {supported: false, reason: "系统通知需要通过 HTTPS 访问 OpenBear。"};
  if (env.ios && !env.standalone) return {supported: false, reason: "iPhone / iPad 需 iOS 16.4 或更新版本，并先将 OpenBear 添加到主屏幕，再从图标打开。"};
  if (!win.Notification || !win.PushManager || !win.navigator?.serviceWorker) return {supported: false, reason: "当前系统或浏览器不支持后台通知，可继续使用 Telegram 通知。"};
  return {supported: true, reason: ""};
}

export function decodePushKey(value) {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

export async function pushRequest(path, body, method = "POST") {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 30000);
  try {
    const response = await fetch(`/api/push/${path}`, {
      method, credentials: "same-origin", cache: "no-store", signal: abort.signal,
      ...(body === undefined ? {} : {headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)}),
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(response.status === 401 ? "登录已失效，请重新登录后开启通知" : data.error || "通知操作失败");
    return data;
  } finally { clearTimeout(timeout); }
}

export function waitForPushWorker(registration, timeoutMs = 15000) {
  if (registration.active?.state === "activated") return Promise.resolve(registration);
  const worker = registration.installing || registration.waiting || registration.active;
  if (!worker) return Promise.reject(new Error("后台通知组件未能启动，请刷新后重试"));
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", changed);
      error ? reject(error) : resolve(registration);
    };
    const changed = () => {
      if (worker.state === "activated") done();
      else if (worker.state === "redundant") done(new Error("后台通知组件安装失败"));
    };
    const timer = setTimeout(() => done(new Error("后台通知组件启动超时，请重试")), timeoutMs);
    worker.addEventListener("statechange", changed);
    changed();
  });
}

export function createPushClient(win, request = pushRequest) {
  async function current() {
    const registration = await win.navigator.serviceWorker.getRegistration("/");
    return {registration, subscription: await registration?.pushManager.getSubscription() || null};
  }
  function changed() { notifyPushChanged(win); }
  return {
    async status() {
      const support = pushSupport(win);
      if (!support.supported) return {...support, enabled: false};
      const {subscription} = await current();
      const data = subscription ? await request("status", {endpoint: subscription.endpoint}) : {enabled: false};
      return {...support, permission: win.Notification.permission, enabled: Boolean(data.enabled && win.Notification.permission === "granted")};
    },
    async enable() {
      const support = pushSupport(win);
      if (!support.supported) throw new Error(support.reason);
      // Called directly from the button click, BEFORE any network/worker await.
      const permission = await win.Notification.requestPermission();
      if (permission !== "granted") throw new Error(permission === "denied" ? "通知权限已被关闭，请在浏览器或系统设置中允许后重试" : "尚未允许通知，可再次点击开启");
      const {publicKey} = await request("key", undefined, "GET");
      const registration = await win.navigator.serviceWorker.register("/openbear-push-sw.js", {scope: "/", updateViaCache: "none"});
      await waitForPushWorker(registration);
      try {
        let subscription = await registration.pushManager.getSubscription();
        const key = decodePushKey(publicKey);
        if (subscription?.options?.applicationServerKey && String(new Uint8Array(subscription.options.applicationServerKey)) !== String(key)) {
          await subscription.unsubscribe();
          subscription = null;
        }
        const fresh = !subscription;
        subscription ||= await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
        try { await request("subscription", {subscription: subscription.toJSON()}); }
        catch (error) { if (fresh) await subscription.unsubscribe().catch(() => {}); throw error; }
      } finally {
        // Rotation/rollback can change the endpoint even when enabling fails.
        changed();
      }
      return {supported: true, permission, enabled: true};
    },
    async disable() {
      const {subscription} = await current();
      try {
        if (subscription) {
          // Disable server delivery first. Keep the worker: it never caches or
          // intercepts the application, and may be shared by another open tab.
          await request("subscription", {endpoint: subscription.endpoint}, "DELETE");
          await subscription.unsubscribe();
        }
      } finally { changed(); }
      return {supported: true, permission: win.Notification.permission, enabled: false};
    },
    async test() {
      const {subscription} = await current();
      if (!subscription) throw new Error("请先开启本设备通知");
      return request("test", {endpoint: subscription.endpoint});
    },
  };
}

export function installPushNavigation(win, navigate) {
  const listener = async event => {
    if (event.data?.type !== "openbear:notification-open") return;
    try {
      const target = notificationTarget(event.data.url, win.location.origin);
      if (!target) return;
      if (target !== win.location.pathname + win.location.search && await navigate(target) === false) return;
      // Also reveal the device card when system settings is already mounted.
      win.dispatchEvent(new win.Event("openbear:notification-navigated"));
    } catch { /* Ignore invalid notification navigation. */ }
  };
  win.navigator.serviceWorker?.addEventListener("message", listener);
  return () => win.navigator.serviceWorker?.removeEventListener("message", listener);
}

export function installPushPresence(win, currentConversation, request = pushRequest) {
  if (!win.navigator.serviceWorker) return {update() {}, stop() {}};
  const clientId = pageId(win);
  let endpoint = "", closed = false, refreshVersion = 0, channel;
  async function refresh() {
    const version = ++refreshVersion;
    endpoint = ""; // Never send a cached endpoint while a newer read is pending.
    try {
      const registration = await win.navigator.serviceWorker?.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (closed || version !== refreshVersion) return;
      endpoint = subscription?.endpoint || "";
      // Refresh existing worker code without registering, prompting or rebinding login.
      if (registration) void registration.update().catch(() => {});
      update();
    } catch { /* Notification support must never block the chat. */ }
  }
  function update() {
    if (closed || !endpoint) return;
    const conversationUuid = win.document.visibilityState === "visible" && win.document.hasFocus() ? currentConversation() : "";
    void request("presence", {endpoint, conversationUuid, clientId}).catch(() => {});
  }
  function visibilityChanged() {
    if (win.document.visibilityState === "visible") void refresh();
    else update();
  }
  function storageChanged(event) { if (event.key === PUSH_CHANGED) void refresh(); }
  try {
    channel = new win.BroadcastChannel(PUSH_CHANGED);
    channel.onmessage = event => { if (event.data === PUSH_CHANGED) void refresh(); };
  } catch { /* Use storage events and focus on older engines. */ }
  win.addEventListener(PUSH_CHANGED, refresh);
  win.addEventListener("storage", storageChanged);
  win.addEventListener("focus", refresh);
  win.addEventListener("blur", update);
  win.document.addEventListener("visibilitychange", visibilityChanged);
  const timer = win.setInterval(() => { if (win.document.visibilityState === "visible") update(); }, 25000);
  void refresh();
  return {update, stop() {
    closed = true;
    win.clearInterval(timer);
    channel?.close();
    win.removeEventListener(PUSH_CHANGED, refresh);
    win.removeEventListener("storage", storageChanged);
    win.removeEventListener("focus", refresh);
    win.removeEventListener("blur", update);
    win.document.removeEventListener("visibilitychange", visibilityChanged);
  }};
}

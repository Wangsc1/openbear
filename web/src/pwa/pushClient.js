import {installationEnvironment} from "./install.js";

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
  function changed() { win.dispatchEvent(new win.Event("openbear:push-changed")); }
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
      changed();
      return {supported: true, permission, enabled: true};
    },
    async disable() {
      const {subscription} = await current();
      if (subscription) {
        // Disable server delivery first. Keep the worker: it never caches or
        // intercepts the application, and may be shared by another open tab.
        await request("subscription", {endpoint: subscription.endpoint}, "DELETE");
        await subscription.unsubscribe();
      }
      changed();
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
  const listener = event => {
    if (event.data?.type !== "openbear:notification-open") return;
    try {
      const url = new URL(event.data.url, win.location.origin);
      if (url.origin !== win.location.origin || !["/chat", "/settings"].includes(url.pathname)) return;
      navigate(url.pathname + url.search);
    } catch { /* Ignore invalid notification navigation. */ }
  };
  win.navigator.serviceWorker?.addEventListener("message", listener);
  return () => win.navigator.serviceWorker?.removeEventListener("message", listener);
}

export function installPushPresence(win, currentConversation, request = pushRequest) {
  if (!win.navigator.serviceWorker) return {update() {}, stop() {}};
  let endpoint = "", closed = false;
  async function refresh() {
    try {
      const registration = await win.navigator.serviceWorker?.getRegistration("/");
      endpoint = (await registration?.pushManager.getSubscription())?.endpoint || "";
      // Refresh existing worker code without registering or prompting on a new device.
      if (registration) void registration.update().catch(() => {});
      update();
    } catch { /* Notification support must never block the chat. */ }
  }
  function update() {
    if (closed || !endpoint) return;
    const conversationUuid = win.document.visibilityState === "visible" && win.document.hasFocus() ? currentConversation() : "";
    void request("presence", {endpoint, conversationUuid}).catch(() => {});
  }
  win.addEventListener("openbear:push-changed", refresh);
  win.addEventListener("focus", update);
  win.addEventListener("blur", update);
  win.document.addEventListener("visibilitychange", update);
  const timer = win.setInterval(() => { if (win.document.visibilityState === "visible") update(); }, 25000);
  void refresh();
  return {update, stop() {
    closed = true;
    win.clearInterval(timer);
    win.removeEventListener("openbear:push-changed", refresh);
    win.removeEventListener("focus", update);
    win.removeEventListener("blur", update);
    win.document.removeEventListener("visibilitychange", update);
  }};
}

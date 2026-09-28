/* Notifications only. No fetch handler, offline cache, or API interception. */
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

function notificationUrl(data) {
  const id = typeof data?.conversationUuid === "string" ? data.conversationUuid : "";
  return id ? `/chat?id=${encodeURIComponent(id)}` : "/settings?section=system-settings&setting=web.taskNotifications.enabled";
}

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data?.json() || {}; } catch { /* Still show a visible notification. */ }
    // Push subscriptions are userVisibleOnly: do not silently consume pushes in
    // the worker (notably iOS may revoke such subscriptions). Foreground quieting
    // happens on the server BEFORE sending, using a short-lived device presence.
    await self.registration.showNotification("OpenBear", {
      body: typeof data.body === "string" ? data.body : "有新的任务动态，请打开查看",
      icon: "/icons/openbear-192.png",
      badge: "/icons/openbear-192.png",
      tag: typeof data.tag === "string" ? data.tag : "openbear-update",
      data: {url: notificationUrl(data)},
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const candidate = new URL(event.notification.data?.url || "/chat", self.location.origin);
    const target = candidate.origin === self.location.origin && ["/chat", "/settings"].includes(candidate.pathname)
      ? candidate.href : new URL("/chat", self.location.origin).href;
    const clients = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    const exact = clients.find(client => client.url === target);
    if (exact) { await exact.focus(); return; }
    // Reuse an existing application window through SPA navigation, not reload:
    // unsent drafts, attachments and an active reply must not be discarded.
    const client = clients.find(item => new URL(item.url).origin === self.location.origin && new URL(item.url).pathname !== "/login");
    if (client) {
      client.postMessage({type: "openbear:notification-open", url: target});
      await client.focus();
    } else {
      await self.clients.openWindow(target);
    }
  })());
});

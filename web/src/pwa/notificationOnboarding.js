import {createPushClient} from "./pushClient.js";

export const NOTIFICATION_PROMPT_KEY = "openbear.notifications.prompt.v1";
export const NOTIFICATION_SETTINGS_PATH = "设置 → 系统设置 → 通知";

// This is a record of the one-time invitation, not the notification permission
// or subscription state. Only the browser and server can report those states.
export function createNotificationOnboarding(win, state, {
  client = createPushClient(win),
  notify = () => {},
} = {}) {
  let checking = false;
  let disposed = false;
  function seen() {
    try { return win.localStorage.getItem(NOTIFICATION_PROMPT_KEY) !== null; }
    catch { return true; } // Cannot persist "once": leave the manual entry available.
  }
  function remember(choice) {
    try {
      win.localStorage.setItem(NOTIFICATION_PROMPT_KEY, JSON.stringify({choice, at: Date.now()}));
      return true;
    } catch { return false; }
  }
  return {
    async start() {
      if (disposed || checking || win.document.visibilityState === "hidden" || seen()) return;
      checking = true;
      try {
        const status = await client.status();
        if (disposed || win.document.visibilityState === "hidden" || seen()) return;
        if (!status.supported) return; // For example, iOS before adding to Home Screen.
        if (status.enabled) { remember("already-enabled"); return; }
        // Record before display: refresh, dismissal and failed permission requests
        // must never turn this invitation into a recurring startup prompt.
        if (remember("shown")) state.open = true;
      } catch {
        // A failed status lookup is not a user decision; do not claim it was shown.
      } finally { checking = false; }
    },
    async enable() {
      if (disposed || !state.open || state.busy || state.phase !== "offer") return;
      remember("enable");
      state.busy = true;
      try {
        // Keep this call in the actual button gesture, before any network await.
        await client.enable();
        remember("enabled");
        if (!disposed) state.phase = "enabled";
      } catch (error) {
        remember(win.Notification?.permission === "denied" ? "denied" : "failed");
        if (!disposed) {
          state.phase = "failed";
          state.error = error.message || "通知未能开启，请在通知设置中重试。";
        }
      } finally { if (!disposed) state.busy = false; }
    },
    dismiss() {
      if (disposed || !state.open || state.busy) return;
      if (state.phase === "offer") {
        remember("dismissed");
        notify(`本次未开启通知，以后不会再次自动询问。可在「${NOTIFICATION_SETTINGS_PATH}」中开启。`);
      }
      state.open = false;
    },
    dispose() { disposed = true; },
  };
}

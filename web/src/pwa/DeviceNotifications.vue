<script setup>
import {onBeforeUnmount, onMounted, ref} from "vue";
import {Bell} from "@lucide/vue";
import {createPushClient, pushSupport} from "./pushClient.js";

const client = createPushClient(window);
const status = ref({...pushSupport(window), enabled: false});
const busy = ref(true);
const message = ref("");
const failed = ref(false);
let refreshVersion = 0;
async function refresh() {
  const version = ++refreshVersion;
  try {
    const next = await client.status();
    if (version === refreshVersion) status.value = next;
  } catch (error) {
    if (version !== refreshVersion) return;
    message.value = error.message || "无法读取通知状态";
    failed.value = true;
  }
}
async function run(action) {
  if (busy.value) return;
  ++refreshVersion; // An older focus refresh must not undo this operation.
  busy.value = true;
  message.value = "";
  failed.value = false;
  try {
    if (action === "enable") {
      status.value = await client.enable();
      message.value = "本设备已开启。可发送测试通知，确认系统能否收到。";
    } else if (action === "disable") {
      status.value = await client.disable();
      message.value = "本设备已关闭，不影响其他设备或 Telegram。";
    } else {
      await client.test();
      message.value = "推送服务已接受测试通知，请检查系统通知中心；这不代表设备已经收到。";
    }
  } catch (error) {
    failed.value = true;
    message.value = error.message || "通知操作失败，请重试";
    await refresh();
  } finally { busy.value = false; }
}
function resume() { if (!busy.value) void refresh(); }
onMounted(() => {
  window.addEventListener("focus", resume);
  void refresh().finally(() => { busy.value = false; });
});
onBeforeUnmount(() => {
  ++refreshVersion;
  window.removeEventListener("focus", resume);
});
</script>

<template>
  <section class="device-notifications" aria-label="本设备系统通知" :aria-busy="busy">
    <header class="device-notifications__heading">
      <h3><Bell :size="16" aria-hidden="true" />本设备系统通知</h3>
      <span class="device-notifications__state" :class="{'is-enabled': status.enabled && !busy}">{{ busy ? '处理中…' : status.enabled ? '已开启' : status.supported ? '未开启' : '暂不支持' }}</span>
    </header>
    <div class="device-notifications__body">
      <div class="device-notifications__main">
        <div class="device-notifications__copy">
          <p>开启后的新任务完成、执行失败或需要确认时提醒，点击通知回到对应会话。</p>
          <p class="device-notifications__hint">适用于当前浏览器、PWA 及安卓 Chrome 安装的应用。不展示回答正文，与 Telegram 通知独立。</p>
        </div>
        <div v-if="status.supported" class="device-notifications__actions">
          <button type="button" class="device-notifications__button" :class="{'is-primary': !status.enabled}" :disabled="busy" @click="run(status.enabled ? 'disable' : 'enable')">{{ status.enabled ? '关闭本设备通知' : '开启本设备通知' }}</button>
          <button v-if="status.enabled" type="button" class="device-notifications__button is-primary" :disabled="busy" @click="run('test')">发送系统测试通知</button>
        </div>
      </div>
      <p v-if="!status.supported" class="device-notifications__notice">{{ status.reason }}</p>
      <p v-else-if="status.permission === 'denied'" class="device-notifications__notice">通知权限已关闭，请先到浏览器或系统设置中允许。</p>
      <p v-if="message" class="device-notifications__feedback" :role="failed ? 'alert' : 'status'" :class="{'is-error': failed}">{{ message }}</p>
    </div>
    <footer class="device-notifications__footnote">
      <p>正在查看同一会话时尽量不重复提醒。锁屏、免打扰、省电限制及推送网络会影响送达；iPhone 需 iOS 16.4+ 且从主屏幕打开。</p>
      <p>通知随本次登录有效，退出、登录到期或撤销登录后需重新开启。</p>
    </footer>
  </section>
</template>

<style scoped>
/* Own these styles: SettingsView's scoped button rules do not reach child content. */
.device-notifications { overflow: hidden; margin: 0 0 14px; border: 1px solid var(--ob-border); border-radius: 18px; background: var(--ob-surface); box-shadow: 0 6px 18px rgb(var(--ob-shadow-rgb) / 0.04), inset 0 1px 0 var(--ob-surface); }
.device-notifications__heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 13px 17px 11px; border-bottom: 1px solid var(--ob-border); background: linear-gradient(180deg, rgb(var(--ob-surface-rgb) / 0.88), rgb(var(--ob-surface-rgb) / 0.58)); }
.device-notifications__heading h3 { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--ob-text-strong); font-size: 14px; font-weight: 700; letter-spacing: -.01em; }
.device-notifications__state { flex-shrink: 0; padding: 3px 8px; border: 1px solid var(--ob-border); border-radius: 999px; color: var(--ob-text-subtle); background: var(--ob-surface-soft); font-size: 11px; line-height: 1.4; }
.device-notifications__state.is-enabled { border-color: rgb(var(--ob-success-rgb) / 0.2); color: var(--ob-success); background: rgb(var(--ob-success-rgb) / 0.08); }
.device-notifications__body { padding: 16px 17px 13px; }
.device-notifications__main { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 24px; }
.device-notifications__copy { min-width: 0; }
.device-notifications p { margin: 0; font-size: 12px; line-height: 1.65; color: var(--ob-text); overflow-wrap: anywhere; }
.device-notifications p.device-notifications__hint { margin-top: 4px; color: var(--ob-text-subtle); }
.device-notifications__actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.device-notifications__button { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 6px 12px; border: 1px solid var(--ob-border-strong); border-radius: 999px; background: rgb(var(--ob-surface-rgb) / 0.88); color: var(--ob-text); font-family: inherit; font-size: 12px; font-weight: 500; line-height: 1.5; white-space: nowrap; cursor: pointer; box-shadow: inset 0 1px 0 var(--ob-border), 0 1px 2px rgb(var(--ob-shadow-rgb) / 0.04); transition: background-color .14s ease, border-color .14s ease, box-shadow .14s ease, opacity .14s ease; }
.device-notifications__button.is-primary { border-color: var(--ob-blue); background: var(--ob-blue); color: var(--ob-text-inverse); box-shadow: inset 0 1px 0 var(--ob-border-strong), 0 3px 10px rgb(var(--ob-blue-rgb) / 0.16); }
.device-notifications__button:hover:not(:disabled) { border-color: var(--ob-blue); box-shadow: 0 3px 10px rgb(var(--ob-shadow-rgb) / 0.12); }
.device-notifications__button:active:not(:disabled) { box-shadow: inset 0 1px 3px rgb(var(--ob-shadow-rgb) / 0.16); }
.device-notifications__button:focus-visible { outline: 2px solid var(--ob-blue); outline-offset: 3px; }
.device-notifications__button:disabled { opacity: .45; cursor: not-allowed; box-shadow: none; }
.device-notifications p.device-notifications__notice { margin-top: 12px; color: var(--ob-warning); }
.device-notifications p.device-notifications__feedback { margin-top: 12px; padding: 8px 10px; border: 1px solid var(--ob-border); border-radius: 10px; background: var(--ob-surface-soft); }
.device-notifications p.device-notifications__feedback.is-error { border-color: rgb(var(--ob-danger-rgb) / 0.25); color: var(--ob-danger); }
.device-notifications__footnote { padding: 10px 17px 12px; border-top: 1px solid var(--ob-border); background: rgb(var(--ob-surface-soft-rgb) / 0.35); }
.device-notifications__footnote p { color: var(--ob-text-subtle); font-size: 11px; }
.device-notifications__footnote p + p { margin-top: 4px; }
@media (max-width: 760px) {
  .device-notifications { border-radius: 16px; }
  .device-notifications__heading { padding: 12px 13px; }
  .device-notifications__body { padding: 13px; }
  .device-notifications__main { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .device-notifications__actions { justify-content: flex-start; }
  .device-notifications__button { min-height: 40px; }
  .device-notifications__footnote { padding: 10px 13px 12px; }
}
</style>

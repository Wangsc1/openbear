<script setup>
import {onBeforeUnmount, onMounted, ref} from "vue";
import {Bell} from "@lucide/vue";
import {createPushClient, pushSupport} from "./pushClient.js";

const client = createPushClient(window);
const status = ref({...pushSupport(window), enabled: false});
const busy = ref(true);
const message = ref("");
const failed = ref(false);
async function refresh() {
  try { status.value = await client.status(); }
  catch (error) { message.value = error.message || "无法读取通知状态"; failed.value = true; }
}
async function run(action) {
  if (busy.value) return;
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
onBeforeUnmount(() => window.removeEventListener("focus", resume));
</script>

<template>
  <div class="device-notifications">
    <div class="device-notifications__heading">
      <Bell :size="18" aria-hidden="true" />
      <strong>本设备系统通知</strong>
      <span>{{ busy ? '处理中…' : status.enabled ? '已开启' : status.supported ? '未开启' : '暂不支持' }}</span>
    </div>
    <p>开启后的新任务完成、执行失败或需要确认时提醒；点击通知回到对应会话。不展示回答正文，与下方 Telegram 通知独立。</p>
    <p v-if="!status.supported" class="device-notifications__hint">{{ status.reason }}</p>
    <p v-else-if="status.permission === 'denied'" class="device-notifications__hint">通知权限已关闭，请先到浏览器或系统设置中允许。</p>
    <div v-if="status.supported" class="device-notifications__actions">
      <button type="button" class="mac-button" :disabled="busy" @click="run(status.enabled ? 'disable' : 'enable')">{{ status.enabled ? '关闭本设备通知' : '开启本设备通知' }}</button>
      <button v-if="status.enabled" type="button" class="mac-text-button" :disabled="busy" @click="run('test')">发送系统测试通知</button>
    </div>
    <p v-if="message" :role="failed ? 'alert' : 'status'" :class="{'device-notifications__error': failed}">{{ message }}</p>
    <p class="device-notifications__hint">正在查看同一会话时尽量不重复提醒。锁屏、免打扰、省电限制及推送网络会影响送达；iPhone 需 iOS 16.4+ 且从主屏幕打开。通知随本次登录有效，退出、登录到期或撤销登录后需重新开启。</p>
  </div>
</template>

<style scoped>
.device-notifications { margin: 0 18px 16px; padding: 15px 16px; border: 1px solid var(--ob-border); border-radius: 12px; background: var(--ob-surface-soft); }
.device-notifications__heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--ob-text-strong); font-size: 13px; }
.device-notifications__heading span { margin-left: auto; color: var(--ob-text-muted); font-size: 12px; }
.device-notifications p { margin: 9px 0 0; font-size: 12px; line-height: 1.65; color: var(--ob-text); overflow-wrap: anywhere; }
.device-notifications p.device-notifications__hint { color: var(--ob-text-muted); }
.device-notifications p.device-notifications__error { color: var(--ob-danger); }
.device-notifications__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.device-notifications button:disabled { opacity: .5; cursor: default; }
@media (max-width: 640px) { .device-notifications { margin: 0 10px 12px; padding: 12px; } }
</style>

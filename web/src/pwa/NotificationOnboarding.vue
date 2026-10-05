<script setup>
import {onBeforeUnmount, onMounted, reactive} from "vue";
import {ElMessage} from "element-plus";
import {Bell} from "@lucide/vue";
import {createNotificationOnboarding, NOTIFICATION_SETTINGS_PATH} from "./notificationOnboarding.js";

const state = reactive({open: false, busy: false, phase: "offer", error: ""});
const onboarding = createNotificationOnboarding(window, state, {
  notify: message => ElMessage.info({message, duration: 8000, showClose: true}),
});
function resume() { void onboarding.start(); }
function visibilityChanged(open) { if (!open) onboarding.dismiss(); }
onMounted(() => {
  document.addEventListener("visibilitychange", resume);
  resume();
});
onBeforeUnmount(() => {
  onboarding.dispose();
  document.removeEventListener("visibilitychange", resume);
});
</script>

<template>
  <el-dialog
    :model-value="state.open"
    :title="state.phase === 'enabled' ? '本设备通知已开启' : state.phase === 'failed' ? '通知未开启' : '开启本设备通知？'"
    width="420px"
    align-center
    append-to-body
    class="notification-onboarding"
    :close-on-click-modal="!state.busy"
    :close-on-press-escape="!state.busy"
    :show-close="!state.busy"
    @update:model-value="visibilityChanged"
  >
    <div class="notification-onboarding__intro">
      <span class="notification-onboarding__icon"><Bell :size="22" aria-hidden="true" /></span>
      <div>
        <strong>不用一直守着页面</strong>
        <p>任务完成、执行失败或需要你确认时，通过系统通知提醒你。</p>
      </div>
    </div>
    <p v-if="state.phase === 'offer'" class="notification-onboarding__detail">适用于当前浏览器或已安装的 OpenBear 应用。不展示回答正文，与 Telegram 通知独立。</p>
    <p v-else-if="state.phase === 'enabled'" class="notification-onboarding__detail" role="status">已完成通知订阅。可在通知设置中发送测试通知，确认系统能否收到。</p>
    <p v-else class="notification-onboarding__error" role="alert">{{ state.error }}</p>
    <div class="notification-onboarding__settings">
      <span>只询问这一次，暂不开启也没关系。以后随时可前往：</span>
      <strong>{{ NOTIFICATION_SETTINGS_PATH }}</strong>
    </div>
    <template #footer>
      <div class="notification-onboarding__actions">
        <template v-if="state.phase === 'offer'">
          <el-button :disabled="state.busy" @click="onboarding.dismiss()">暂不开启</el-button>
          <el-button type="primary" :loading="state.busy" @click="onboarding.enable()">开启通知</el-button>
        </template>
        <el-button v-else type="primary" @click="onboarding.dismiss()">知道了</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style>
.notification-onboarding.el-dialog { max-width: calc(100vw - 32px); border-radius: 16px; }
</style>
<style scoped>
.notification-onboarding__intro { display: flex; align-items: flex-start; gap: 12px; color: var(--ob-text-strong); }
.notification-onboarding__icon { display: grid; place-items: center; width: 44px; height: 44px; flex-shrink: 0; border: 1px solid var(--ob-border); border-radius: 12px; background: var(--ob-surface-soft); color: var(--el-color-primary); }
.notification-onboarding__intro strong { font-size: 14px; font-weight: 600; }
.notification-onboarding__intro p, .notification-onboarding__detail { margin: 6px 0 0; font-size: 13px; line-height: 1.7; color: var(--ob-text); }
.notification-onboarding__detail, .notification-onboarding__error { margin-top: 16px; }
.notification-onboarding__error { font-size: 13px; line-height: 1.7; color: var(--ob-danger); overflow-wrap: anywhere; }
.notification-onboarding__settings { display: grid; gap: 6px; margin-top: 16px; padding: 12px; border-radius: 10px; background: var(--ob-surface-soft); font-size: 12px; line-height: 1.7; color: var(--ob-text-muted); }
.notification-onboarding__settings strong { font-weight: 500; color: var(--ob-text-strong); }
.notification-onboarding__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.notification-onboarding__actions :deep(.el-button + .el-button) { margin-left: 0; }
</style>

<script setup>
import {computed, ref, watch} from 'vue';
import {Timer, ArrowRight} from '@element-plus/icons-vue';
import CronRunDialog from '../../components/cron/CronRunDialog.vue';
import {scheduleText, time} from '../../components/cron/cronConfig.js';
const props = defineProps({message: {type: Object, required: true}});
const open = ref(false);
const card = computed(() => props.message.cronCard || {});
const runId = computed(() => card.value.runId || props.message.cronRunId || String(props.message.opId || '').replace(/^msg:/, ''));
const name = computed(() => card.value.name || '定时任务');
const trigger = computed(() => ({scheduled:'自动触发',manual:'手动执行'})[card.value.trigger] || '任务执行');
const startedAt = computed(() => card.value.startedAtMs || Number(props.message.createdAt || 0) * 1000 || null);
watch(() => props.message.opId, () => {open.value = false;});
</script>

<template>
  <button type="button" class="event-envelope" aria-haspopup="dialog" :aria-label="`查看定时任务：${name}`" @click="open = true">
    <span class="event-envelope-icon" aria-hidden="true"><el-icon><Timer/></el-icon></span>
    <span class="event-envelope-main">
      <span class="event-envelope-label">定时任务 <span>· {{ trigger }}</span></span>
      <strong>{{ name }}</strong>
      <span v-if="card.schedule" class="event-envelope-summary">{{ scheduleText(card.schedule) }}</span>
      <span class="event-envelope-meta"><time>{{ time(startedAt) }}</time><span v-if="runId" class="event-envelope-id">#{{ runId.slice(0, 8) }}</span></span>
    </span>
    <el-icon class="event-envelope-arrow"><ArrowRight/></el-icon>
  </button>
  <CronRunDialog v-if="open" :run-id="runId" :model-input="message.content" :show-conversation-link="false" @close="open = false" />
</template>

<style scoped src="./eventMessageCard.css"></style>

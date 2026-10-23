<script setup>
import {computed, ref} from 'vue';
import {SetUp, ArrowRight} from '@element-plus/icons-vue';
import {time} from '../../components/cron/cronConfig.js';
const props = defineProps({message: {type: Object, required: true}});
const open = ref(false);
const card = computed(() => props.message.instanceCard || {});
const maintenance = computed(() => card.value.kind === 'maintenance');
const title = computed(() => card.value.name || '实例');
const summary = computed(() => maintenance.value
  ? (card.value.instructions || '按指定范围维护实例。')
  : '交付文件、构建镜像、启动容器，再检查并报告结果。');
const target = computed(() => [card.value.server, card.value.workspacePath, card.value.port ? `端口 ${card.value.port}` : ''].filter(Boolean).join(' · '));
const startedAt = computed(() => card.value.startedAtMs || Number(props.message.createdAt || 0) * 1000 || null);
const operationId = computed(() => card.value.operationId || String(props.message.opId || '').replace(/^msg:/, ''));
</script>

<template>
  <button type="button" class="event-envelope" aria-haspopup="dialog" :aria-label="`${maintenance ? '实例维护' : '实例部署'}：${title}`" @click="open = true">
    <span class="event-envelope-icon" aria-hidden="true"><el-icon><SetUp/></el-icon></span>
    <span class="event-envelope-main">
      <span class="event-envelope-label">{{ maintenance ? '实例维护' : '实例部署' }} <span>· 主控发起</span></span>
      <strong>{{ title }}</strong>
      <span class="event-envelope-summary">{{ summary }}</span>
      <span class="event-envelope-meta"><span v-if="target">{{ target }}</span><time>{{ time(startedAt) }}</time><span v-if="operationId" class="event-envelope-id">#{{ operationId.slice(0, 8) }}</span></span>
    </span>
    <el-icon class="event-envelope-arrow"><ArrowRight/></el-icon>
  </button>
  <el-dialog v-model="open" :title="`${maintenance ? '维护' : '部署'}指令 · ${title}`" width="620px" class="admin-dialog instance-message-dialog" append-to-body>
    <p class="instance-message-note">主控发给执行模型的原始指令。实例凭证通过受保护的引用提供，不在这里显示。</p>
    <pre class="instance-message-input">{{ message.content }}</pre>
  </el-dialog>
</template>

<style scoped src="./eventMessageCard.css"></style>
<style>
.instance-message-dialog .instance-message-note{margin:0 0 10px;font-size:12px;color:var(--ob-text-muted);}
.instance-message-dialog .instance-message-input{margin:0;max-height:60vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.7;padding:12px;border-radius:8px;background:var(--ob-bg-subtle,var(--el-fill-color-light));color:var(--ob-text);}
</style>

<script setup>
import {computed, ref} from 'vue';
import {Connection, ArrowRight} from '@element-plus/icons-vue';
import {time} from '../../components/cron/cronConfig.js';
import CollabRequestDetail from './CollabRequestDetail.vue';
import {collabStateTone, collabStatusLabel, OPEN_STATES, useCollabRequests} from './collabRequests.js';

// The receiver's view of an incoming request: the envelope already says who
// asked, what for, and where it stands; the dialog holds the full exchange.
const props = defineProps({message: {type: Object, required: true}});
const store = useCollabRequests();
const card = computed(() => props.message.collabCard || {});
const requestId = computed(() => card.value.requestId || props.message.collabRequestId || '');
const live = computed(() => store?.get(requestId.value) || null);
const label = computed(() => card.value.supply ? '补充材料' : '会话请求');
// A request can span several receiver turns (needs input → material → reply).
// This card belongs to one of them: show how that turn ended.
const turnUuid = computed(() => card.value.turnUuid || props.message.turnUuid || '');
const turnState = computed(() => live.value?.turnOutcomes?.[turnUuid.value] || live.value?.state || '');
const view = computed(() => live.value ? {...live.value, state: turnState.value} : null);
const status = computed(() => turnState.value === 'needs_input' && live.value?.state !== 'needs_input' ? '已要求补充' : collabStatusLabel(view.value));
const tone = computed(() => view.value ? collabStateTone(view.value.state) : 'info');
const ending = computed(() => {
  const state = turnState.value;
  if (state === 'cancelled') return '请求方已取消，这一轮被停止';
  if (state === 'limit_reached') return '补充次数已到上限，没有得出结论';
  if (state === 'needs_input') return live.value?.state === 'needs_input' ? '等待请求方补充材料' : '请求方已补充，后续见下方';
  return '';
});
const startedAt = computed(() => Number(props.message.createdAt || 0) * 1000 || null);
const open = ref(false);
function openSender() {
  open.value = false;
  window.dispatchEvent(new CustomEvent('openbear:open-conversation', {detail: {conversationUuid: card.value.fromConversationUuid}}));
}
</script>

<template>
  <button type="button" class="event-envelope collab-envelope" :class="`tone-${tone}`" aria-haspopup="dialog" :aria-label="`查看${label}：${card.title || ''}`" @click="open = true">
    <span class="event-envelope-icon" aria-hidden="true"><el-icon><Connection/></el-icon></span>
    <span class="event-envelope-main">
      <span class="event-envelope-label">{{ label }} <span>· 来自「{{ card.fromTitle || '另一个会话' }}」</span></span>
      <strong>{{ card.title || '会话请求' }}</strong>
      <span v-if="ending" class="event-envelope-summary">{{ ending }}</span>
      <span class="event-envelope-meta">
        <span v-if="status" class="collab-status" :class="{'is-open': OPEN_STATES.has(turnState) && turnState !== 'needs_input' || live?.state === 'needs_input'}">{{ status }}</span>
        <time>{{ time(startedAt) }}</time>
      </span>
    </span>
    <el-icon class="event-envelope-arrow"><ArrowRight/></el-icon>
  </button>
  <el-dialog v-model="open" width="min(720px, calc(100vw - 24px))" append-to-body class="mobile-viewport-dialog collab-request-dialog" destroy-on-close>
    <template #header>
      <div class="collab-dialog-head">
        <strong>{{ card.title || '会话请求' }}</strong>
        <span>{{ label }} · 来自「{{ card.fromTitle || '另一个会话' }}」<template v-if="status"> · <em :class="`tone-${tone}`">{{ status }}</em></template></span>
      </div>
    </template>
    <CollabRequestDetail v-if="requestId" :request-id="requestId" :request="live" perspective="receiver"/>
    <template #footer>
      <el-button v-if="card.fromConversationUuid" @click="openSender">打开发起会话</el-button>
      <el-button type="primary" @click="open = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped src="./eventMessageCard.css"></style>
<style scoped>
.collab-status{display:inline-flex;align-items:center;gap:4px;font-weight:650;color:var(--el-color-primary);}
.collab-status.is-open::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;animation:collab-pulse 1.6s ease-in-out infinite;}
.collab-envelope.tone-success{border-left-color:var(--ob-success);}.collab-envelope.tone-success .collab-status{color:var(--ob-success);}
.collab-envelope.tone-warning{border-left-color:var(--ob-warning);}.collab-envelope.tone-warning .collab-status{color:var(--ob-warning);}
.collab-envelope.tone-danger{border-left-color:var(--ob-danger);}.collab-envelope.tone-danger .collab-status{color:var(--ob-danger);}
.collab-envelope.tone-muted{border-left-color:var(--ob-border-strong);}.collab-envelope.tone-muted .collab-status{color:var(--ob-text-muted);}
.collab-dialog-head{display:grid;gap:4px;min-width:0;padding-right:28px;overflow-wrap:anywhere;}
.collab-dialog-head strong{font-size:15px;}.collab-dialog-head span{font-size:12px;color:var(--ob-text-muted);}
.collab-dialog-head em{font-style:normal;font-weight:650;}
.collab-dialog-head .tone-success{color:var(--ob-success);}.collab-dialog-head .tone-warning{color:var(--ob-warning);}.collab-dialog-head .tone-danger{color:var(--ob-danger);}.collab-dialog-head .tone-info{color:var(--el-color-primary);}
@keyframes collab-pulse{50%{opacity:.35;}}
@media(prefers-reduced-motion:reduce){.collab-status.is-open::before{animation:none;}}
</style>

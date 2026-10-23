<script setup>
import {computed, ref, watch} from 'vue';
import {ElDialog, ElDrawer} from 'element-plus';
import {ArrowRight, Close, Warning} from '@element-plus/icons-vue';
import {useAdminPhone} from '../adminViewport.js';
import {activityLabel} from '../conversationActivity.js';

const props = defineProps({open:Boolean, items:{type:Array,default:()=>[]}, activeConversationUuid:{type:String,default:''}});
const emit = defineEmits(['update:open','open-conversation']);
const phone = useAdminPhone();
const closing = ref(false), offset = ref(0), dragging = ref(false);
const summary = computed(() => props.items.find(item => item.conversationUuid !== props.activeConversationUuid) || props.items[0]);
const panelStyle = computed(() => phone.value && offset.value ? {'--pending-drag-y':`${offset.value}px`,transform:closing.value?undefined:`translateY(${offset.value}px)`} : undefined);
let gesture = null, selected = null;
watch(() => props.open, open => { if (open) { closing.value = false; offset.value = 0; selected = null; } });
function close() { gesture = null; dragging.value = false; closing.value = true; }
function closed() {
  emit('update:open', false);
  if (selected) emit('open-conversation', selected);
  selected = null;
}
function choose(row, request) { selected = {row, interactionId:request?.interactionId || ''}; close(); }
function requestLabel(row, request) { return activityLabel({...row, activityPending:[request]}); }
function startDrag(event) {
  if (!phone.value || closing.value || event.pointerType === 'mouse' || event.target.closest('button')) return;
  gesture = {id:event.pointerId, x:event.clientX, y:event.clientY};
  event.currentTarget.setPointerCapture(event.pointerId);
}
function moveDrag(event) {
  if (!gesture || event.pointerId !== gesture.id) return;
  const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
  if (!dragging.value && (dy < 0 || Math.abs(dx) > Math.abs(dy))) { cancelDrag(); return; }
  dragging.value = true;
  offset.value = Math.max(0, dy);
}
function cancelDrag() { gesture = null; dragging.value = false; offset.value = 0; }
function endDrag() { if (offset.value >= 88) close(); else cancelDrag(); }
</script>

<template>
  <button v-if="items.length" type="button" class="mobile-pending-entry" :aria-label="`${items.length} 个会话待处理，查看待处理列表`" :aria-expanded="open" @click="emit('update:open', true)">
    <Warning aria-hidden="true"/><strong>待处理 {{ items.length }}</strong><span>{{ summary?.title || '新会话' }}</span><ArrowRight aria-hidden="true"/>
  </button>
  <component :is="phone ? ElDrawer : ElDialog" :model-value="open && !closing" title="待处理会话" :with-header="false" :show-close="false" direction="btt" size="auto" width="520px" append-to-body destroy-on-close class="pending-conversations" :class="{'is-phone':phone,'is-dragging':dragging}" modal-class="pending-conversations-overlay" :style="panelStyle" @close="close" @closed="closed">
    <header class="pending-header" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="cancelDrag">
      <i v-if="phone" class="pending-grip" aria-hidden="true"></i>
      <h2>待处理会话 <span>{{ items.length }}</span></h2>
      <button type="button" aria-label="关闭待处理列表" @click="close"><Close/></button>
    </header>
    <div class="pending-content">
      <section v-for="row in items" :key="row.conversationUuid" class="pending-conversation" :data-pending-conversation="row.conversationUuid">
        <div class="pending-title"><h3>{{ row.title || '新会话' }}</h3><small v-if="row.conversationUuid === activeConversationUuid">当前</small></div>
        <p class="pending-path">{{ row.path || '临时会话' }}</p>
        <div class="pending-requests">
          <button v-for="(request,index) in row.activityPending || []" :key="request.interactionId" type="button" :data-interaction-id="request.interactionId" @click="choose(row, request)">
            <span>{{ requestLabel(row, request) }}<small v-if="row.activityPending.length > 1"> · 第 {{ index + 1 }} 项</small></span><ArrowRight aria-hidden="true"/>
          </button>
          <button v-if="!row.activityPending?.length" type="button" @click="choose(row)"><span>查看待处理事项</span><ArrowRight aria-hidden="true"/></button>
        </div>
      </section>
      <p v-if="!items.length" class="pending-empty">当前没有待处理会话</p>
    </div>
  </component>
</template>

<style>
.mobile-pending-entry { display:none; }
.pending-conversations.el-dialog { display:flex; flex-direction:column; max-width:calc(100vw - 32px); max-height:75vh; margin:12vh auto 0; padding:0; border:1px solid var(--ob-border); border-radius:12px; background:var(--ob-surface); color:var(--ob-text); overflow:hidden; }
.pending-conversations.el-dialog > .el-dialog__header { display:none; }
.pending-conversations .el-dialog__body,.pending-conversations .el-drawer__body { display:flex; flex-direction:column; min-height:0; padding:0; overflow:hidden; }
.pending-header { position:relative; display:flex; flex:none; align-items:center; gap:10px; padding:10px 16px; border-bottom:1px solid var(--ob-border); }
.pending-header h2 { flex:1; margin:0; font-size:14px; font-weight:500; }
.pending-header h2 span { margin-left:6px; color:var(--ob-warning); font-variant-numeric:tabular-nums; }
.pending-header button { display:grid; place-items:center; width:32px; height:32px; border:0; border-radius:6px; background:transparent; color:var(--ob-text-muted); cursor:pointer; }
.pending-header button svg { width:17px; height:17px; }
.pending-content { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:0 16px 8px; }
.pending-conversation { padding:12px 0; }
.pending-conversation + .pending-conversation { border-top:1px solid var(--ob-border); }
.pending-title { display:flex; align-items:baseline; gap:8px; }
.pending-title h3 { min-width:0; margin:0; font-size:13px; font-weight:500; overflow-wrap:anywhere; }
.pending-title > small { flex:none; color:var(--ob-text-muted); font-size:10px; }
.pending-path { margin:3px 0 7px; color:var(--ob-text-muted); font-size:11px; line-height:1.5; overflow-wrap:anywhere; }
.pending-requests { display:flex; flex-wrap:wrap; gap:6px; }
.pending-requests button { display:flex; flex:1 1 130px; min-width:0; align-items:center; justify-content:space-between; gap:8px; min-height:34px; padding:5px 9px; border:1px solid rgb(var(--ob-warning-rgb) / .22); border-radius:7px; background:rgb(var(--ob-warning-rgb) / .06); color:var(--ob-warning); font-size:12px; text-align:left; cursor:pointer; }
.pending-requests button svg { width:13px; height:13px; flex:none; }
.pending-requests button small { font:inherit; }
.pending-requests button:hover { background:rgb(var(--ob-warning-rgb) / .12); }
.pending-conversations button:focus-visible,.mobile-pending-entry:focus-visible { outline:2px solid var(--ob-focus); outline-offset:-2px; }
.pending-empty { margin:22px 0; text-align:center; color:var(--ob-text-muted); font-size:12px; }
.pending-conversations.is-phone { --el-drawer-padding-primary:0; max-height:calc(var(--mobile-viewport-height,100dvh) - max(12px,env(safe-area-inset-top,0px))); border-radius:16px 16px 0 0; background:var(--ob-surface); color:var(--ob-text); transition:transform 280ms cubic-bezier(.22,.68,0,1); }
.pending-conversations.is-phone .pending-header { touch-action:none; padding-top:16px; }
.pending-grip { position:absolute; top:7px; left:calc(50% - 15px); width:30px; height:4px; border-radius:4px; background:var(--ob-border-strong); }
.pending-conversations.is-phone .pending-header button { width:44px; height:44px; }
.pending-conversations.is-phone .pending-content { padding-bottom:max(16px,env(safe-area-inset-bottom,0px)); }
.pending-conversations.is-phone .pending-requests button { min-height:44px; }
.pending-conversations.is-dragging { transition:none; user-select:none; }
.pending-conversations-overlay.el-drawer-fade-leave-active { transition:background-color 280ms linear; }
.pending-conversations-overlay.el-drawer-fade-leave-from .pending-conversations { transform:translateY(var(--pending-drag-y,0px)); }
.pending-conversations-overlay.el-drawer-fade-leave-active .pending-conversations { pointer-events:none; }
@media (max-width:760px) {
  .mobile-pending-entry { display:flex; flex:none; align-items:center; gap:7px; width:100%; min-width:0; min-height:44px; padding:5px 14px; border:0; border-bottom:1px solid rgb(var(--ob-warning-rgb) / .16); background:rgb(var(--ob-warning-rgb) / .06); color:var(--ob-warning); text-align:left; font-size:12px; cursor:pointer; }
  .mobile-pending-entry strong { flex:none; font-weight:500; font-variant-numeric:tabular-nums; }
  .mobile-pending-entry > span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ob-text-subtle); }
  .mobile-pending-entry svg { width:14px; height:14px; flex:none; }
  .pending-conversations-overlay { top:var(--mobile-viewport-top,0px); bottom:auto; height:var(--mobile-viewport-height,100%); }
}
@media (prefers-reduced-motion:reduce) {
  .pending-conversations.is-phone,.pending-conversations-overlay.el-drawer-fade-leave-active { transition-duration:1ms; }
}
</style>

<script setup>
import {nextTick,onBeforeUnmount,onMounted,ref} from 'vue';
import {autoUpdate,computePosition,flip,offset,shift} from '@floating-ui/dom';
import {X} from '@lucide/vue';
const props=defineProps({anchor:Object,title:String});
const emit=defineEmits(['close']);
const panel=ref(null),position=ref({left:'12px',top:'80px',visibility:'hidden'});
let cleanup=null,previousFocus=null,disposed=false;
async function place(){
  if(!panel.value)return;
  const anchor=props.anchor;
  if(!anchor?.getBoundingClientRect){position.value={left:'max(12px, calc(50vw - 190px))',top:'15vh'};return;}
  const result=await computePosition(anchor,panel.value,{strategy:'fixed',placement:'right-start',middleware:[offset(10),flip({fallbackPlacements:['left-start','bottom','top']}),shift({padding:12})]});
  if(!disposed)position.value={left:`${result.x}px`,top:`${result.y}px`};
}
function keydown(event){
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();emit('close');return;}
  if(event.key!=='Tab')return;
  const controls=[...panel.value.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter(el=>el.getClientRects().length);
  const first=controls[0],last=controls.at(-1);
  if(!first){event.preventDefault();return;}
  if(event.shiftKey && (document.activeElement===first || document.activeElement===panel.value)){event.preventDefault();last.focus();}
  else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
}
onMounted(async()=>{
  previousFocus=document.activeElement;
  if(props.anchor?.getBoundingClientRect)cleanup=autoUpdate(props.anchor,panel.value,place);else await place();
  await nextTick();panel.value?.querySelector('[data-autofocus] input,input[data-autofocus],textarea[data-autofocus]')?.focus();
  if(!panel.value?.contains(document.activeElement))panel.value?.focus();
});
onBeforeUnmount(()=>{disposed=true;cleanup?.();if(previousFocus?.isConnected)previousFocus.focus();});
</script>
<template>
  <Teleport to="body">
    <div class="cron-cal-popover-layer" @click.self="emit('close')">
      <section ref="panel" class="cron-root cron-cal-popover" :style="position" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="keydown">
        <header class="cron-cal-popover-head"><span>{{ title }}</span><button type="button" class="cron-cal-icon-button" aria-label="关闭" @click="emit('close')"><X :size="16" /></button></header>
        <div class="cron-cal-popover-body"><slot /></div>
        <footer v-if="$slots.footer" class="cron-cal-popover-footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

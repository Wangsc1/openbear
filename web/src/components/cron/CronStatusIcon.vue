<script setup>
import {computed} from 'vue';
import {Clock3,LoaderCircle,CircleCheck,CircleAlert,CirclePause,CircleMinus,ChartNoAxesColumnIncreasing} from '@lucide/vue';
import {statusInfo} from './cronCalendar.js';
const props=defineProps({status:String});
const info=computed(()=>statusInfo(props.status));
const icons={Clock3,LoaderCircle,CircleCheck,CircleAlert,CirclePause,CircleMinus,ChartNoAxesColumnIncreasing};
</script>
<template><component :is="icons[info.icon]" class="cron-cal-status-icon" :class="{'is-spinning':info.tone==='running'}" :data-tone="info.tone" :size="13" :stroke-width="1.8" :aria-label="info.label" role="img" /></template>

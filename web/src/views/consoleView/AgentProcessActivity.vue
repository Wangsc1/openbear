<script setup>
import {computed, onBeforeUnmount, onMounted, ref, watch} from "vue";
import AgentActivityList from "./AgentActivityList.vue";
import {compactAgentStepActivityLines} from "./agentPlanPresentation.js";

const props = defineProps({
	sourceLines: {type: Array, default: () => []},
	modelLabel: {type: String, default: ""},
	thinkLevel: {type: String, default: ""},
	fastMode: {type: Boolean, default: false},
	limit: {type: Number, default: 0},
	emptyText: {type: String, default: "暂无过程记录。"},
});

const now = ref(Date.now());
const displayLines = computed(() => {
	const lines = compactAgentStepActivityLines(props.sourceLines, {
		modelLabel: props.modelLabel,
		thinkLevel: props.thinkLevel,
		fastMode: props.fastMode,
		nowMs: now.value,
	});
	return props.limit > 0 ? lines.slice(-props.limit) : lines;
});

const hasActiveParameters = computed(() => displayLines.value.some(
	(line) => line.modelStatus === "running" && line.detail?.toolInput,
));
let mounted = false;
let timer;
function syncClock() {
	clearInterval(timer);
	timer = undefined;
	if (mounted && hasActiveParameters.value) {
		now.value = Date.now();
		timer = setInterval(() => {now.value = Date.now();}, 1000);
	}
}
watch(hasActiveParameters, syncClock, {flush: "sync"});
onMounted(() => {mounted = true; syncClock();});
onBeforeUnmount(() => {mounted = false; clearInterval(timer);});
</script>

<template>
	<AgentActivityList :lines="displayLines" :empty-text="emptyText" compact/>
</template>

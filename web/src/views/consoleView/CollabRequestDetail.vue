<script setup>
import {computed, ref, watch} from "vue";
import {Api, apiError} from "../../api.js";
import {time} from "../../components/cron/cronConfig.js";
import ConsoleMarkdown from "./ConsoleMarkdown.vue";
import {collabEventLabel, collabStatusLabel, OPEN_STATES} from "./collabRequests.js";

// Read-only request detail, shared by the sender's request row and the
// receiver's request card. Loads lazily; `request` is the live summary.
const props = defineProps({
	requestId: {type: String, required: true},
	request: {type: Object, default: null},
	perspective: {type: String, default: "sender"},
});
const emit = defineEmits(["changed"]);
const detail = ref(null), loading = ref(false), error = ref(""), cancelling = ref(false);
let generation = 0;

async function load() {
	const run = ++generation;
	loading.value = !detail.value;
	error.value = "";
	try {
		const data = await Api.collabRequest(props.requestId);
		if (run === generation) detail.value = data.request;
	} catch (e) {
		if (run === generation) error.value = apiError(e);
	} finally {
		if (run === generation) loading.value = false;
	}
}
// Reload when the live state moves, so an open detail never shows a stale outcome.
watch(() => [props.requestId, props.request?.state, props.request?.updatedAtMs], load, {immediate: true});

const view = computed(() => ({...(detail.value || {}), ...(props.request || {})}));
const open = computed(() => OPEN_STATES.has(view.value.state));
// A note is shown only when it adds something the reply does not already say.
const outcomeNote = computed(() => {
	const v = view.value;
	if (v.state === "needs_input") return v.question || detail.value?.question || "对方没有写明缺什么";
	// After a completed reply the declaration only restates it; the reply speaks for itself.
	if (v.state === "completed" && detail.value?.resultText) return "";
	return String(detail.value?.note || "").trim();
});
const noteLabel = computed(() => ({needs_input: "对方要补充", rejected: "拒绝原因", cancelled: "取消原因", limit_reached: "说明", failed: "说明"})[view.value.state] || "说明");
const noteTone = computed(() => ({needs_input: "warning", rejected: "danger", failed: "danger"})[view.value.state] || "info");
// The plain send → deliver → result path is implied by the status; list the
// record only when something else happened (material, cancellation, late reply).
const events = computed(() => {
	const items = (detail.value?.events || []).filter(item => item.kind !== "sent");
	return items.some(item => !["delivered", "result"].includes(item.kind)) ? items : [];
});

async function cancel() {
	if (cancelling.value) return;
	cancelling.value = true;
	try {
		await Api.cancelCollabRequest(props.requestId);
		emit("changed");
		await load();
	} catch (e) {
		error.value = apiError(e);
	} finally {
		cancelling.value = false;
	}
}
</script>

<template>
	<div class="collab-detail">
		<p v-if="loading" class="detail-notice" role="status">正在读取请求…</p>
		<p v-else-if="error" class="detail-notice is-error" role="alert">{{ error }} <button type="button" class="link-button" @click="load">重试</button></p>
		<template v-if="detail">
			<section v-if="outcomeNote" class="detail-section">
				<h4>{{ noteLabel }}</h4>
				<p class="detail-note" :class="`tone-${noteTone}`">{{ outcomeNote }}</p>
			</section>
			<section v-if="detail.resultText" class="detail-section">
				<h4>{{ perspective === 'sender' ? `${view.to?.title || '对方'}的回复` : '你的回复' }}</h4>
				<div class="detail-text" tabindex="0" role="region" aria-label="回复正文"><ConsoleMarkdown :text="detail.resultText" :artifact-cards="false"/></div>
			</section>
			<section class="detail-section">
				<h4>请求内容</h4>
				<div class="detail-text" tabindex="0" role="region" aria-label="请求内容"><ConsoleMarkdown :text="detail.body || ''" :artifact-cards="false"/></div>
			</section>
			<section v-if="events.length" class="detail-section">
				<h4>往来记录</h4>
				<ol class="detail-events">
					<li v-for="(item, index) in events" :key="index">
						<span>{{ collabEventLabel(item.kind) }}<template v-if="item.body && !['result', 'delivered'].includes(item.kind)">：{{ item.body }}</template></span><time>{{ time(item.atMs) }}</time>
					</li>
				</ol>
			</section>
			<div v-if="open && perspective === 'sender'" class="detail-actions">
				<span>{{ collabStatusLabel(view) }}</span>
				<button type="button" class="link-button danger" :disabled="cancelling" @click="cancel">{{ cancelling ? '正在撤回…' : '撤回请求' }}</button>
			</div>
		</template>
	</div>
</template>

<style scoped>
.collab-detail { display: grid; gap: .8rem; min-width: 0; }
.detail-notice { margin: 0; font-size: .72rem; color: var(--ob-text-subtle); }
.detail-notice.is-error { color: var(--ob-danger); }
.detail-section { display: grid; gap: .3rem; min-width: 0; }
.detail-section + .detail-section { border-top: 1px solid var(--ob-border-soft, var(--ob-border)); padding-top: .7rem; }
.detail-section h4 { margin: 0; font-size: 12px; font-weight: 600; color: var(--ob-text-subtle); }
.detail-text { max-height: min(36vh, 22rem); max-height: min(36dvh, 22rem); overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; font-size: 13px; line-height: 1.65; color: var(--ob-text); }
.detail-text:focus-visible { outline: 2px solid var(--ob-interaction-border-strong, var(--ob-focus)); outline-offset: 2px; border-radius: 4px; }
.detail-text :deep(> :first-child) { margin-top: 0; }
.detail-text :deep(> :last-child) { margin-bottom: 0; }
.detail-note { margin: 0; border-left: 2px solid var(--ob-blue); padding-left: .55rem; font-size: 13px; line-height: 1.6; color: var(--ob-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.detail-note.tone-warning { border-left-color: var(--ob-warning); }
.detail-note.tone-danger { border-left-color: var(--ob-danger); }
.detail-events { display: grid; gap: .25rem; margin: 0; padding: 0; list-style: none; }
.detail-events li { display: flex; justify-content: space-between; gap: .75rem; font-size: 12px; color: var(--ob-text); }
.detail-events li > span { min-width: 0; overflow-wrap: anywhere; }
.detail-events time { flex: 0 0 auto; font-size: 11px; color: var(--ob-text-muted); font-variant-numeric: tabular-nums; }
.detail-actions { display: flex; align-items: center; justify-content: space-between; gap: .75rem; border-top: 1px solid var(--ob-border-soft, var(--ob-border)); padding-top: .6rem; font-size: 12px; color: var(--ob-text-subtle); }
.link-button { border: 0; background: transparent; padding: 0; font: inherit; font-size: 12px; font-weight: 600; color: var(--ob-blue); cursor: pointer; }
.link-button.danger { color: var(--ob-danger); }
.link-button:disabled { opacity: .55; cursor: not-allowed; }
@media (hover: none) and (pointer: coarse) {
	.link-button { min-height: 2.25rem; }
}
</style>

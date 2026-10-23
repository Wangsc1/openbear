<script setup>
import {computed, reactive, ref, watch} from "vue";
import {buildProposalAnswer, changedPaths, cloneProposal, validateProposal} from "./groupProposal.js";
import GroupEditor from "./GroupEditor.vue";
import InteractionMarkdown from "./InteractionMarkdown.vue";

const props = defineProps({
	item: {type: Object, required: true},
	disabled: {type: Boolean, default: false},
	submitting: {type: Boolean, default: false},
	error: {type: String, default: ""},
});
const emit = defineEmits(["answer"]);

const mode = computed(() => String(props.item.mode || "create"));
const models = computed(() => Array.isArray(props.item.models) ? props.item.models : []);
const original = computed(() => cloneProposal(props.item.proposal || {}));
const draft = reactive(cloneProposal(props.item.proposal || {}));
const comment = ref("");
const errors = ref({});
const groupEditable = computed(() => mode.value === "create" || mode.value === "update");
const changed = computed(() => changedPaths(original.value, draft));
const edited = computed(() => changed.value.size > 0);
const removing = computed(() => mode.value === "remove_member");

watch(() => props.item.confirmationId, () => {
	Object.assign(draft, cloneProposal(props.item.proposal || {}));
	comment.value = "";
	errors.value = {};
});

function clearError(path) {
	if (!errors.value[path]) return;
	const next = {...errors.value};
	delete next[path];
	errors.value = next;
}

function submit(decision) {
	if (props.disabled) return;
	if (decision === "reject" && !comment.value.trim()) {
		errors.value = {...errors.value, comment: "否决时请写明意见，主会话会按意见修改"};
		return;
	}
	if (decision !== "reject" && !removing.value) {
		const found = validateProposal(draft, mode.value, models.value);
		errors.value = found;
		if (Object.keys(found).length) return;
	}
	const approve = comment.value.trim() && !removing.value ? "approve_with_comment" : "approve";
	emit("answer", buildProposalAnswer(decision === "reject" ? "reject" : approve, draft, comment.value));
}

const approveLabel = computed(() => {
	if (props.submitting) return "提交中…";
	if (removing.value) return "确认移除";
	if (edited.value && comment.value.trim()) return "按修改批准并附意见";
	if (edited.value) return "按修改后的版本批准";
	return comment.value.trim() ? "批准并附意见" : "批准";
});
</script>

<template>
	<div class="group-proposal">
		<div v-if="item.reason" class="proposal-reason">
			<span>{{ removing ? '移除原因' : '主会话说明' }}</span>
			<InteractionMarkdown :text="item.reason"/>
		</div>

		<div v-if="mode !== 'create' && mode !== 'update'" class="proposal-scope">
			{{ removing ? '将被移除的成员' : '新增成员' }} {{ draft.members.length }} 人<template v-if="!removing"> · 可修改，不能删减；不想要请否决</template>
		</div>
		<div v-else class="proposal-scope">{{ draft.members.length }} 位成员 · 可修改任何字段，不能删减成员；不想要请否决</div>
		<GroupEditor :draft="draft" :models="models" :errors="errors" :changed="changed" :disabled="disabled"
		             :group-editable="groupEditable" :members-editable="!removing"
		             :member-rules="item.memberRules || ''" @clear-error="clearError"/>

		<label class="proposal-comment" :class="{'has-error': errors.comment}">
			<span>意见 <em>{{ removing ? '选填' : '批准时可选，否决时必填' }}</em></span>
			<textarea v-model="comment" rows="2" :disabled="disabled" :placeholder="removing ? '' : '例如：审稿人再严格一些；或说明否决原因'" @input="clearError('comment')"></textarea>
			<small v-if="errors.comment" role="alert">{{ errors.comment }}</small>
			<small v-else-if="edited" class="proposal-note">你的修改会逐项告诉主会话，以你提交的版本为准。</small>
		</label>
		<div v-if="error" class="interaction-submit-error" role="alert">{{ error }}</div>
		<div class="proposal-actions">
			<button type="button" class="web-confirm-btn reject" :disabled="disabled" @click="submit('reject')">{{ removing ? '不移除' : '否决' }}</button>
			<button type="button" class="web-confirm-btn confirm" :disabled="disabled" :aria-busy="submitting ? 'true' : 'false'" @click="submit('approve')">{{ approveLabel }}</button>
		</div>
	</div>
</template>

<style scoped src="./interactionControls.css"></style>
<style scoped>
.group-proposal { display: grid; gap: .6rem; min-width: 0; margin-top: .65rem; }
.proposal-reason { display: grid; gap: .25rem; border-left: 2px solid var(--ob-interaction-border-strong); padding-left: .6rem; font-size: .75rem; color: var(--ob-interaction-muted); }
.proposal-reason > span { font-size: .68rem; font-weight: 700; color: var(--ob-interaction-accent-strong); }
.proposal-scope { font-size: .7rem; color: var(--ob-interaction-muted); }
.proposal-comment { display: grid; min-width: 0; gap: .28rem; font-size: .7rem; font-weight: 650; color: var(--ob-text); }
.proposal-comment > span em { margin-left: .35rem; font-style: normal; font-weight: 400; color: var(--ob-interaction-muted); }
.proposal-comment textarea { box-sizing: border-box; width: 100%; resize: vertical; border: 1px solid var(--ob-border); border-radius: .68rem; background: var(--ob-interaction-surface-strong); padding: .55rem .62rem; font: inherit; font-size: .78rem; font-weight: 400; line-height: 1.5; color: var(--ob-interaction-ink); outline: none; }
.proposal-comment textarea:focus { border-color: var(--ob-interaction-border-strong); box-shadow: 0 0 0 3px var(--ob-interaction-focus); }
.proposal-comment.has-error textarea { border-color: var(--ob-danger); }
.proposal-comment small { font-size: .68rem; font-weight: 400; }
.proposal-comment small[role="alert"] { color: var(--ob-danger); }
.proposal-note { color: var(--ob-interaction-muted); }
/* Sticky so the decision stays reachable while the card scrolls internally. */
.proposal-actions { position: sticky; bottom: -.85rem; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .5rem; margin: 0 -.85rem -.85rem; border-top: 1px solid var(--ob-interaction-border); background: var(--ob-interaction-surface); padding: .6rem .85rem .85rem; }
@media (hover: none) and (pointer: coarse) {
	.proposal-comment textarea { font-size: 16px; }
}
</style>

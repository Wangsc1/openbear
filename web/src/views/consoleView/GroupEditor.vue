<script setup>
import {computed, nextTick, ref, watch} from "vue";
import {GROUP_PATHS, GROUP_PROMPT_FIELDS, applyModel, groupHasError, memberChanged, memberHasError, modelInfo, modelThinkingLevels} from "./groupProposal.js";
import InteractionMarkdown from "./InteractionMarkdown.vue";

// Edits `draft` in place. Membership is fixed here: proposals and properties
// may change fields, never add, drop or reorder members.
const props = defineProps({
	draft: {type: Object, required: true},
	models: {type: Array, default: () => []},
	errors: {type: Object, default: () => ({})},
	changed: {type: Object, default: () => new Set()},
	disabled: {type: Boolean, default: false},
	groupEditable: {type: Boolean, default: true},
	membersEditable: {type: Boolean, default: true},
	memberRules: {type: String, default: ""},
});
const emit = defineEmits(["clear-error"]);

const tabs = computed(() => [
	...(props.groupEditable ? [{id: "group", label: "小组", changed: GROUP_PATHS.some(path => props.changed.has(path)), error: groupHasError(props.errors)}] : []),
	...props.draft.members.map((member, index) => ({
		id: `member-${index}`, index, label: member.name || `成员 ${index + 1}`,
		changed: memberChanged(props.changed, index), error: memberHasError(props.errors, index),
	})),
	...(props.memberRules ? [{id: "rules", label: "固定规则"}] : []),
]);
const active = ref(tabs.value[0]?.id || "");
const current = computed(() => tabs.value.find(tab => tab.id === active.value) || tabs.value[0]);
const member = computed(() => current.value?.index === undefined ? null : props.draft.members[current.value.index]);
const tabList = ref(null);

watch(() => tabs.value.map(tab => tab.id).join("|"), () => {
	if (!tabs.value.some(tab => tab.id === active.value)) active.value = tabs.value[0]?.id || "";
});
// A failed submit jumps to the first tab that needs attention.
watch(() => props.errors, errors => {
	if (!Object.keys(errors).length || current.value?.error) return;
	const target = tabs.value.find(tab => tab.error);
	if (target) select(target.id);
});

function select(id) {
	const scroller = tabList.value?.closest(".group-proposal-card, .el-dialog__body");
	const pinned = scroller && tabList.value.getBoundingClientRect().top <= scroller.getBoundingClientRect().top + 1;
	active.value = id;
	nextTick(() => {
		tabList.value?.querySelector(`[data-tab="${id}"]`)?.scrollIntoView({block: "nearest", inline: "nearest"});
		// A pinned tab bar means the old panel was scrolled; start the new one at its top.
		if (pinned) tabList.value.scrollIntoView({block: "start"});
	});
}
function tabKeydown(event) {
	const step = {ArrowRight: 1, ArrowLeft: -1}[event.key];
	if (!step) return;
	event.preventDefault();
	const ids = tabs.value.map(tab => tab.id);
	const next = ids[(ids.indexOf(active.value) + step + ids.length) % ids.length];
	select(next);
	nextTick(() => tabList.value?.querySelector(`[data-tab="${next}"]`)?.focus());
}
function clear(path) { emit("clear-error", path); }
function setModel(key) {
	applyModel(member.value, props.models, key);
	clear(`members.${current.value.index}.model`);
}
const levels = computed(() => modelThinkingLevels(modelInfo(props.models, member.value?.model)));
const supportsFast = computed(() => Boolean(modelInfo(props.models, member.value?.model)?.supportsFast));
const path = key => `members.${current.value.index}.${key}`;

// Grow with the content instead of reserving empty rows; long text scrolls inside.
function fit(el) {
	el.style.height = "auto";
	el.style.height = `${el.scrollHeight + 2}px`;
}
const vAutosize = {mounted: fit, updated: fit};
</script>

<template>
	<div class="group-editor">
		<nav ref="tabList" class="group-tabs" role="tablist" aria-label="小组与成员" @keydown="tabKeydown">
			<button v-for="tab in tabs" :key="tab.id" type="button" role="tab" :data-tab="tab.id"
			        :aria-selected="active === tab.id" :tabindex="active === tab.id ? 0 : -1"
			        :class="{active: active === tab.id, 'has-error': tab.error}" @click="select(tab.id)">
				{{ tab.label }}<i v-if="tab.error" class="tab-dot error" aria-label="需修改"></i><i v-else-if="tab.changed" class="tab-dot" aria-label="已修改"></i>
			</button>
		</nav>

		<section v-if="current?.id === 'group'" class="group-tab-panel" role="tabpanel" aria-label="小组设定">
			<label class="proposal-field" :class="{'has-error': errors.name, 'is-edited': changed.has('name')}">
				<span>小组名称</span>
				<input v-model="draft.name" type="text" maxlength="60" :disabled="disabled" @input="clear('name')"/>
				<small v-if="errors.name" role="alert">{{ errors.name }}</small>
			</label>
			<label class="proposal-field" :class="{'is-edited': changed.has('description')}">
				<span>说明</span>
				<textarea v-model="draft.description" v-autosize rows="1" :disabled="disabled"></textarea>
			</label>
			<label v-for="[key, label] in GROUP_PROMPT_FIELDS" :key="key" class="proposal-field" :class="{'has-error': errors[`prompt.${key}`], 'is-edited': changed.has(`prompt.${key}`)}">
				<span>{{ label }}</span>
				<textarea v-model="draft.prompt[key]" v-autosize rows="1" :disabled="disabled" @input="clear(`prompt.${key}`)"></textarea>
				<small v-if="errors[`prompt.${key}`]" role="alert">{{ errors[`prompt.${key}`] }}</small>
			</label>
			<label class="proposal-field" :class="{'has-error': errors.workspaceDir, 'is-edited': changed.has('workspaceDir')}">
				<span>工作目录 <em>留空则新建独立目录</em></span>
				<input v-model="draft.workspaceDir" type="text" :disabled="disabled" placeholder="/opt/…" @input="clear('workspaceDir')"/>
				<small v-if="errors.workspaceDir" role="alert">{{ errors.workspaceDir }}</small>
			</label>
		</section>

		<section v-else-if="member" class="group-tab-panel" role="tabpanel" :aria-label="`成员「${member.name}」`">
			<div class="member-config">
				<label class="proposal-field" :class="{'has-error': errors[path('name')], 'is-edited': changed.has(path('name'))}">
					<span>名称</span>
					<input v-model="member.name" type="text" maxlength="40" :disabled="disabled || !membersEditable" @input="clear(path('name'))"/>
					<small v-if="errors[path('name')]" role="alert">{{ errors[path('name')] }}</small>
				</label>
				<label class="proposal-field" :class="{'has-error': errors[path('model')]}">
					<span>模型</span>
					<el-select :model-value="member.model" :disabled="disabled || !membersEditable" filterable :aria-label="`${member.name}的模型`"
					           popper-class="folder-properties-popover" :show-arrow="false" @change="setModel">
						<el-option v-for="model in models" :key="model.key" :value="model.key" :label="model.label || model.key"/>
					</el-select>
					<small v-if="errors[path('model')]" role="alert">{{ errors[path('model')] }}</small>
				</label>
				<label class="proposal-field">
					<span>思考强度</span>
					<el-select v-if="levels.length" v-model="member.thinkingLevel" :disabled="disabled || !membersEditable" :aria-label="`${member.name}的思考强度`"
					           popper-class="folder-properties-popover" :show-arrow="false">
						<el-option v-for="level in levels" :key="level" :value="level" :label="level"/>
					</el-select>
					<span v-else class="field-unsupported">该模型不支持</span>
				</label>
				<label v-if="supportsFast" class="proposal-field proposal-switch">
					<span>Fast</span>
					<el-switch v-model="member.fast" :disabled="disabled || !membersEditable" :aria-label="`${member.name}的 Fast`"/>
				</label>
			</div>
			<label class="proposal-field member-prompt" :class="{'has-error': errors[path('prompt')], 'is-edited': changed.has(path('prompt'))}">
				<span>提示词 <em>小组存续期间一直生效；每次具体做什么由请求说明</em></span>
				<textarea v-model="member.prompt" v-autosize rows="3" :disabled="disabled || !membersEditable" @input="clear(path('prompt'))"></textarea>
				<small v-if="errors[path('prompt')]" role="alert">{{ errors[path('prompt')] }}</small>
			</label>
		</section>

		<section v-else-if="current?.id === 'rules'" class="group-tab-panel" role="tabpanel" aria-label="成员固定规则">
			<p class="proposal-hint">所有成员都会收到这些规则，不能在这里修改。</p>
			<InteractionMarkdown class="rules-body" :text="memberRules"/>
		</section>
	</div>
</template>

<style scoped src="./groupEditor.css"></style>

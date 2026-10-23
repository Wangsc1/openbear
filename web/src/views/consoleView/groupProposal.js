// Editable draft for a ConversationGroup proposal. The server re-validates;
// these checks only keep the panel from submitting what it would reject.
// Same rules as display.js; kept here so this module stays free of .vue imports.
export function modelThinkingLevels(model) {
	return Array.isArray(model?.thinkingLevels) ? model.thinkingLevels.filter(Boolean) : [];
}

function modelDefaultThinking(model) {
	const levels = modelThinkingLevels(model);
	return model?.defaultThinkingLevel || levels[levels.length - 1] || "";
}

export const GROUP_PROMPT_FIELDS = [
	["goal", "任务目标和用途"],
	["facts", "已确定的事实和决定"],
	["constraints", "约束与不做的事"],
	["deliverables", "交付标准"],
];
export const MODE_LABELS = {
	create: "新建小组",
	add_members: "新增成员",
	update: "修改设定",
	remove_member: "移除成员",
};

function text(value) {
	return String(value ?? "");
}

function clonePrompt(prompt, fields) {
	const source = prompt && typeof prompt === "object" ? prompt : {};
	return Object.fromEntries(fields.map(([key]) => [key, text(source[key])]));
}

export function cloneProposal(proposal = {}) {
	return {
		name: text(proposal.name),
		description: text(proposal.description),
		workspaceDir: text(proposal.workspaceDir),
		prompt: clonePrompt(proposal.prompt, GROUP_PROMPT_FIELDS),
		members: (Array.isArray(proposal.members) ? proposal.members : []).map(member => ({
			memberKey: text(member.memberKey),
			name: text(member.name),
			model: text(member.model),
			thinkingLevel: text(member.thinkingLevel),
			fast: Boolean(member.fast),
			prompt: typeof member.prompt === "string" ? member.prompt : "",
		})),
	};
}

export function modelInfo(models, key) {
	return (Array.isArray(models) ? models : []).find(item => item.key === key) || null;
}

/** Keep thinking/fast valid after a model change, as ModelSettings does. */
export function applyModel(member, models, key) {
	const info = modelInfo(models, key);
	member.model = key;
	const levels = modelThinkingLevels(info);
	if (!levels.length) member.thinkingLevel = "";
	else if (!levels.includes(member.thinkingLevel)) member.thinkingLevel = modelDefaultThinking(info);
	if (!info?.supportsFast) member.fast = false;
	return member;
}

export function memberSummary(member, models) {
	const info = modelInfo(models, member.model);
	const parts = [info?.label || member.model || "未选模型"];
	if (member.thinkingLevel) parts.push(member.thinkingLevel);
	if (member.fast) parts.push("fast");
	return parts.join(" · ");
}

export function validateProposal(draft, mode, models) {
	const errors = {};
	if (mode === "create" || mode === "update") {
		if (!draft.name.trim()) errors.name = "小组名称必填";
		for (const [key, label] of GROUP_PROMPT_FIELDS) {
			if (!draft.prompt[key].trim()) errors[`prompt.${key}`] = `请填写「${label}」：成员没有全局视角`;
		}
		if (draft.workspaceDir.trim() && !draft.workspaceDir.trim().startsWith("/")) errors.workspaceDir = "工作目录必须是绝对路径";
	}
	const names = new Set();
	draft.members.forEach((member, index) => {
		const prefix = `members.${index}`;
		if (!member.name.trim()) errors[`${prefix}.name`] = "成员名称必填";
		else if (names.has(member.name.trim())) errors[`${prefix}.name`] = "成员名称不能重复";
		names.add(member.name.trim());
		if (!modelInfo(models, member.model)) errors[`${prefix}.model`] = "请选择可用模型";
		if (!member.prompt.trim()) errors[`${prefix}.prompt`] = "请填写成员提示词";
	});
	return errors;
}

export const GROUP_PATHS = ["name", "description", "workspaceDir", ...GROUP_PROMPT_FIELDS.map(([key]) => `prompt.${key}`)];

export function groupHasError(errors) {
	return GROUP_PATHS.some(path => path in errors);
}

export function memberHasError(errors, index) {
	const prefix = `members.${index}.`;
	return Object.keys(errors).some(key => key.startsWith(prefix));
}

function same(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Field paths the human changed, for the "已修改" markers and submit label. */
export function changedPaths(original, draft) {
	const out = new Set();
	for (const key of ["name", "description", "workspaceDir"]) if (!same(original[key], draft[key])) out.add(key);
	for (const [key] of GROUP_PROMPT_FIELDS) if (!same(original.prompt[key], draft.prompt[key])) out.add(`prompt.${key}`);
	draft.members.forEach((member, index) => {
		const before = original.members[index] || {};
		for (const key of ["name", "model", "thinkingLevel", "fast", "prompt"]) if (!same(before[key], member[key])) out.add(`members.${index}.${key}`);
	});
	return out;
}

export function memberChanged(paths, index) {
	const prefix = `members.${index}.`;
	return [...paths].some(path => path.startsWith(prefix));
}

export function buildProposalAnswer(decision, draft, comment) {
	const answer = {decision, text: text(comment).trim()};
	if (decision !== "reject") answer.proposal = JSON.parse(JSON.stringify(draft));
	return answer;
}

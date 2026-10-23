import test from "node:test";
import assert from "node:assert/strict";

import {applyModel, buildProposalAnswer, changedPaths, cloneProposal, groupHasError, memberChanged, memberHasError, memberSummary, validateProposal} from "./groupProposal.js";
import {groupTreeRows, leadGroupStatus} from "../../components/conversationGroupsTree.js";

const models = [
	{key: "a/opus", label: "Opus", thinkingLevels: ["low", "high", "xhigh"], defaultThinkingLevel: "high", supportsFast: false},
	{key: "b/grok", label: "Grok", thinkingLevels: [], supportsFast: true},
];
const proposal = {
	name: "讨论组", description: "", workspaceDir: "",
	prompt: {goal: "g", facts: "f", constraints: "c", deliverables: "d"},
	members: [{memberKey: "rev", name: "审稿人", model: "a/opus", thinkingLevel: "xhigh", fast: false,
		prompt: "持续审查方案，按请求给出意见。"}],
};

test("changing a model keeps thinking and fast valid", () => {
	const draft = cloneProposal(proposal);
	applyModel(draft.members[0], models, "b/grok");
	assert.equal(draft.members[0].thinkingLevel, "");
	draft.members[0].fast = true;
	applyModel(draft.members[0], models, "a/opus");
	assert.equal(draft.members[0].thinkingLevel, "high");
	assert.equal(draft.members[0].fast, false);
	assert.equal(memberSummary(draft.members[0], models), "Opus · high");
});

test("edits are tracked per field and per member", () => {
	const original = cloneProposal(proposal);
	const draft = cloneProposal(proposal);
	assert.equal(changedPaths(original, draft).size, 0);
	draft.members[0].prompt = "更严格地持续审查";
	draft.prompt.facts = "f2";
	const paths = changedPaths(original, draft);
	assert.deepEqual([...paths].sort(), ["members.0.prompt", "prompt.facts"]);
	assert.equal(memberChanged(paths, 0), true);
});

test("validation requires background sections and member roles", () => {
	const draft = cloneProposal(proposal);
	draft.prompt.goal = " ";
	draft.members[0].prompt = " ";
	draft.members[0].model = "missing";
	const errors = validateProposal(draft, "create", models);
	assert.ok(errors["prompt.goal"].includes("全局视角"));
	assert.ok(errors["members.0.prompt"]);
	assert.equal(groupHasError(errors), true);
	assert.equal(memberHasError(errors, 0), true);
	assert.ok(errors["members.0.model"]);
	assert.equal(Object.keys(validateProposal(cloneProposal(proposal), "create", models)).length, 0);
	assert.ok(!("prompt.goal" in validateProposal({...cloneProposal(proposal), prompt: {goal: "", facts: "", constraints: "", deliverables: ""}}, "add_members", models)));
});

test("answers keep membership and drop the proposal on reject", () => {
	const draft = cloneProposal(proposal);
	assert.equal(buildProposalAnswer("approve", draft, " ").text, "");
	assert.equal(buildProposalAnswer("approve", draft, "").proposal.members[0].memberKey, "rev");
	assert.equal("proposal" in buildProposalAnswer("reject", draft, "不行"), false);
});

test("groups stay collapsed and surface running members on the lead", () => {
	const groups = [{groupId: "g1", name: "讨论组", leadConversationUuid: "L", memberCount: 2, runningCount: 1,
		members: [{conversationUuid: "m1", name: "甲", title: "甲 · 讨论组"}, {conversationUuid: "m2", name: "乙", removed: true}]}];
	assert.deepEqual(leadGroupStatus(groups), {groupCount: 1, groupRunning: 1, groupMembers: 2, expandId: "lead:L"});
	assert.deepEqual(groupTreeRows(groups, {depth: 1, expanded: new Set()}), []);
	const rows = groupTreeRows(groups, {depth: 1, expanded: new Set(["lead:L"])});
	assert.deepEqual(rows.map(row => row.kind), ["group"]);
	const lookup = new Map([["m1", {currentStatus: "运行中"}]]);
	const open = groupTreeRows(groups, {depth: 1, expanded: new Set(["lead:L", "group:g1"]), lookup});
	assert.deepEqual(open.map(row => [row.kind, row.depth, row.running || false]), [["group", 2, false], ["conversation", 3, true]]);
	assert.equal(open[1].groupMember, true);
});

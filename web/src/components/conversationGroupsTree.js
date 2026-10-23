// Tree rows for lead-owned groups. Groups hang under their lead conversation and
// stay collapsed by default; running members always surface on the lead row.

export const leadExpandId = conversationUuid => `lead:${conversationUuid}`;
export const groupExpandId = groupId => `group:${groupId}`;

/** Fields merged into the lead conversation row. */
export function leadGroupStatus(groups) {
	const list = Array.isArray(groups) ? groups : [];
	if (!list.length) return {};
	const running = list.reduce((sum, group) => sum + Number(group.runningCount || 0), 0);
	const members = list.reduce((sum, group) => sum + Number(group.memberCount || 0), 0);
	return {groupCount: list.length, groupRunning: running, groupMembers: members, expandId: leadExpandId(list[0] ? list[0].leadConversationUuid || "" : "")};
}

/** Rows below a lead: groups, and members of expanded groups. */
export function groupTreeRows(groups, {depth = 0, expanded = new Set(), lookup, activityLookup} = {}) {
	const list = Array.isArray(groups) ? groups : [];
	if (!list.length) return [];
	const leadUuid = list[0].leadConversationUuid || "";
	if (!expanded.has(leadExpandId(leadUuid))) return [];
	const rows = [];
	for (const group of list) {
		const expandId = groupExpandId(group.groupId);
		rows.push({
			kind: "group", id: expandId, expandId, groupId: group.groupId, name: group.name,
			description: group.description || "", depth: depth + 1,
			memberCount: Number(group.memberCount || 0), runningCount: Number(group.runningCount || 0),
			leadConversationUuid: leadUuid,
		});
		if (!expanded.has(expandId)) continue;
		for (const member of group.members || []) {
			if (member.removed) continue;
			const status = lookup?.get?.(member.conversationUuid);
			const activity = activityLookup?.get?.(member.conversationUuid);
			rows.push({
				kind: "conversation", id: member.conversationUuid, conversationUuid: member.conversationUuid,
				title: member.title || member.name, memberName: member.name, groupMember: true, groupId: group.groupId,
				groupName: group.name,
				archived: Boolean(member.archived),
				origin: "collab", depth: depth + 2, folderId: "", path: group.name,
				...(activity || {}), ...(status || {}), running: Boolean(status), status: status ? "running" : "idle",
			});
		}
	}
	return rows;
}

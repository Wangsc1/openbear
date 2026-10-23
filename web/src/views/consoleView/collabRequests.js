import {inject, ref} from "vue";

const EVENT_LABELS = {
	sent: "发出请求",
	delivered: "送达对方",
	needs_input: "对方要求补充",
	input: "已补充材料",
	result: "得出结果",
	cancelled: "已取消",
	late: "取消后迟到的回复（未送回）",
};

export function collabEventLabel(kind) {
	return EVENT_LABELS[kind] || kind;
}

export const OPEN_STATES = new Set(["queued", "delivered", "working", "needs_input"]);

/** Same tone names as the interaction cards (status-chip colours). */
export function collabStateTone(state) {
	if (state === "completed") return "success";
	if (state === "needs_input") return "warning";
	if (["rejected", "failed", "limit_reached"].includes(state)) return "danger";
	if (state === "cancelled") return "muted";
	return "info";
}

export function collabStatusLabel(request) {
	if (!request) return "";
	return request.stateLabel || request.state || "";
}

export const COLLAB_REQUESTS_KEY = Symbol("openbear.console.collabRequests");

/**
 * Live request states for the open conversation, keyed by requestId. Tool rows
 * only record the moment of sending; this is what tells the reader where each
 * request is now.
 */
export function createCollabRequestStore(api) {
	const byId = ref(new Map());
	let conversation = "";
	let generation = 0;
	let timer = 0;
	async function load(uuid = conversation) {
		conversation = uuid || "";
		const run = ++generation;
		if (!conversation || conversation.startsWith("local:")) {
			byId.value = new Map();
			return;
		}
		try {
			const data = await api.conversationCollab(conversation);
			if (run !== generation) return;
			const next = new Map();
			for (const item of data.outgoing || []) next.set(item.requestId, {...item, direction: "outgoing"});
			for (const item of data.incoming || []) next.set(item.requestId, {...item, direction: "incoming"});
			byId.value = next;
		} catch {
			// A failed refresh keeps the last known states; the next push retries.
		}
	}
	function changed(uuid) {
		if (!uuid || uuid !== conversation) return;
		window.clearTimeout(timer);
		timer = window.setTimeout(() => void load(), 150);
	}
	function reset(uuid) {
		window.clearTimeout(timer);
		byId.value = new Map();
		void load(uuid);
	}
	function forCall(toolCallId) {
		if (!toolCallId) return null;
		for (const item of byId.value.values()) if (item.toolCallId === toolCallId) return item;
		return null;
	}
	return {byId, load, changed, reset, get: id => byId.value.get(id) || null, forCall};
}

export function useCollabRequests() {
	return inject(COLLAB_REQUESTS_KEY, null);
}

/** Request id + intent from a ConversationRequest tool call, or null. */
export function collabToolCall(event) {
	const call = (event?.calls || [])[0] || {};
	const name = call.name || event?.toolName || event?.operation?.payload?.toolName;
	if (name !== "ConversationRequest") return null;
	const parse = value => {
		if (value && typeof value === "object") return value;
		try { return JSON.parse(String(value || "{}")); } catch { return {}; }
	};
	const payload = event?.operation?.payload || {};
	const args = parse(call.arguments ?? payload.arguments ?? payload.args);
	const result = parse(event?.results?.[0]?.content ?? payload.result);
	return {action: String(args.action || ""), args, result, requestId: String(result.requestId || args.requestId || ""),
		toolCallId: String(call.id || payload.toolCallId || "")};
}

/** Requests a turn sent, oldest first: the sender's standing summary. */
export function turnRequests(store, rootTurnId) {
	if (!store || !rootTurnId) return [];
	return [...store.byId.value.values()]
		.filter(item => item.rootTurnId === rootTurnId && item.direction === "outgoing")
		.sort((a, b) => Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0));
}

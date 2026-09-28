// The timeline already separates answer and reasoning entries. Keep answer bytes
// (including Markdown whitespace) intact; only add a separator between answers.
export function replyMarkdownText(entries = []) {
	return entries
		.filter(({event, part}) => event?.kind === "answer" && part !== "reasoning")
		.map(({event}) => String(event?.message?.content ?? ""))
		.filter(text => text.trim())
		.join("\n\n");
}

export function replyShareCapabilities(text, {navigator: nav, secure, FileClass} = {}) {
	const result = {text: false, file: null};
	if (!text?.trim() || !secure || typeof nav?.share !== "function") return result;
	try {
		result.text = typeof nav.canShare !== "function" || nav.canShare({text}) === true;
	} catch { /* Explicit fallback remains available. */ }
	if (typeof FileClass !== "function" || typeof nav.canShare !== "function") return result;
	try {
		const file = new FileClass([text], "openbear-reply.md", {type: "text/markdown"});
		if (nav.canShare({files: [file]})) result.file = file;
	} catch { /* File sharing is optional even when text sharing is supported. */ }
	return result;
}

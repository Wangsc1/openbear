// A turn-top pixel offset cannot preserve a line inside a wrapping paragraph.
// Keep a character in the visible line instead. DOM references are used only
// while connected to the same turn; transcript replacement falls back to the
// existing turn anchor rather than restoring a node from another render.
function textRangeRect(node, start, end) {
	if (!node?.ownerDocument?.createRange || start < 0 || end > (node.textContent || "").length) return null;
	try {
		const range = node.ownerDocument.createRange();
		range.setStart(node, start);
		range.setEnd(node, end);
		const rect = range.getBoundingClientRect();
		return rect && rect.height > 0 ? rect : null;
	} catch {
		return null;
	}
}

export function transcriptContentAnchorDelta(anchor, turn, viewport) {
	if (!anchor || !turn?.contains?.(anchor.node)) return null;
	const rect = textRangeRect(anchor.node, anchor.offset, anchor.offset + 1);
	return rect ? rect.top - viewport.top - anchor.viewportOffset : null;
}

// Locate a row by its outer box before touching text. Reading text geometry
// inside every offscreen row both scales with the whole turn and defeats native
// content-visibility by forcing skipped subtrees to lay out.
export function visibleTranscriptAnchorRoot(turn, viewport) {
	const rows = turn?.querySelectorAll?.('.timed-row');
	if (!rows?.length) return turn;
	const targetY = viewport.top + Math.min(80, viewport.height * 0.12);
	const boxes = new Map();
	const box = index => {
		if (!boxes.has(index)) boxes.set(index, rows[index].getBoundingClientRect());
		return boxes.get(index);
	};
	let low = 0, high = rows.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (box(mid).bottom <= targetY) low = mid + 1;
		else high = mid;
	}
	let nearest = null, distance = Infinity;
	for (const index of [low - 1, low]) {
		if (index < 0 || index >= rows.length) continue;
		const rect = box(index);
		if (rect.height <= 0 || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
		const delta = Math.max(rect.top - targetY, targetY - rect.bottom, 0);
		if (delta < distance) { nearest = rows[index]; distance = delta; }
	}
	return nearest;
}

export function captureTranscriptContentAnchor(turn, viewport, previous = null) {
	// During a multi-frame width animation keep the exact same character, not
	// the newly wrapped line's first character on each frame (which would drift).
	const root = visibleTranscriptAnchorRoot(turn, viewport);
	if (!root) return null;
	const previousDelta = transcriptContentAnchorDelta(previous, root, viewport);
	if (previousDelta !== null && Math.abs(previousDelta) < 1) return previous;
	const doc = turn?.ownerDocument;
	if (!doc?.createTreeWalker || !doc.createRange) return null;
	const targetY = viewport.top + Math.min(80, viewport.height * 0.12);
	const walker = doc.createTreeWalker(root, 4); // NodeFilter.SHOW_TEXT
	let nearest = null;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!String(node.textContent || "").trim()) continue;
		const range = doc.createRange();
		range.selectNodeContents(node);
		for (const rect of range.getClientRects()) {
			if (rect.height <= 0 || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
			const distance = Math.max(rect.top - targetY, targetY - rect.bottom, 0);
			if (!nearest || distance < nearest.distance) nearest = {node, top: rect.top, distance};
		}
		if (nearest?.distance === 0) break;
	}
	if (!nearest) return null;
	// Find the first character on the chosen line without measuring every
	// character in a potentially very long streamed answer.
	const {node, top} = nearest;
	let low = 0, high = node.textContent.length - 1;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		// Prefix bottoms are monotonic even across collapsed whitespace.
		const rect = textRangeRect(node, 0, middle + 1);
		if (rect && rect.bottom > top + 0.5) high = middle;
		else low = middle + 1;
	}
	const rect = textRangeRect(node, low, low + 1);
	return rect ? {node, offset: low, viewportOffset: rect.top - viewport.top} : null;
}

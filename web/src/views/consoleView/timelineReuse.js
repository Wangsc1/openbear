// The reducer/projection remains authoritative (including cross-turn Agent and
// steering dependencies). Reuse its unchanged output instead of making Vue
// invalidate every old event on each streaming paint. Only the last snapshot is
// retained; removed turns/events cannot accumulate in a second history cache.
function record(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function identity(item) {
	return item?.id || item?.eventKey || item?.opId || '';
}

function reuseList(previous, next, keyed = false) {
	if (previous === next) return previous;
	if (!Array.isArray(previous)) return next;
	const byId = keyed ? new Map(previous.filter(identity).map(item => [identity(item), item])) : null;
	let same = previous.length === next.length;
	const result = next.map((item, index) => {
		const old = byId && identity(item) ? byId.get(identity(item)) : previous[index];
		const value = reuseValue(old, item);
		if (value !== previous[index]) same = false;
		return value;
	});
	return same ? previous : result;
}

function reuseValue(previous, next, key = '') {
	if (previous === next) return previous;
	// Operation snapshots are immutable reducer inputs, not generated view data.
	// A changed snapshot must remain observable even if its visible text matches.
	if (key === 'operation') return next;
	if (Array.isArray(next)) return reuseList(previous, next, key === 'events' || key === 'localTimeline');
	if (!record(previous) || !record(next)) return next;
	const keys = Object.keys(next);
	let same = Object.keys(previous).length === keys.length;
	const result = {};
	for (const name of keys) {
		result[name] = reuseValue(previous[name], next[name], name);
		if (!Object.hasOwn(previous, name) || result[name] !== previous[name]) same = false;
	}
	return same ? previous : result;
}

export function createTimelineReuse() {
	let previous = [];
	return next => (previous = reuseList(previous, next, true));
}

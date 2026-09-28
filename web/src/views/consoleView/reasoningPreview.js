// The collapsed preview is a continuous strip; the expanded source stays intact.
export function reasoningPreviewText(value) {
	return String(value || '').replace(/\s+/gu, ' ').trim();
}

// This marker is supplied by the controller's display-only encrypted fallback.
// Never infer encryption from the shape of ordinary readable reasoning.
export function reasoningPreviewState(value) {
	const raw = String(value || '');
	const marker = '加密思考（不可读）\n';
	const encrypted = raw.startsWith(marker);
	return {encrypted, text: encrypted ? raw.slice(marker.length).replace(/\s+/gu, '') : reasoningPreviewText(raw)};
}

export function createReasoningPreview(viewport, initialValue, env = window) {
	const track = viewport.firstElementChild;
	if (!track) return {update() {}, sync() {}, dispose() {}};
	const media = env.matchMedia?.('(prefers-reduced-motion: reduce)');
	const desktopMedia = env.matchMedia?.('(min-width: 761px) and (hover: hover) and (pointer: fine)');
	let desktop = Boolean(desktopMedia?.matches), desktopLeft = 0, desktopTail = null;
	const originalTransform = track.style?.transform || '', originalWillChange = track.style?.willChange || '';
	let target = '', visible = [], pending = [], consumed = 0;
	let frame = 0, previousTime = null, credit = 0, disposed = false, encrypted = false;
	// Like the running-label sweep, the opaque strip is an execution-state
	// indicator. Reduced motion slows it down instead of skipping to a static
	// tail; readable prose still honors the no-animation preference.
	const canAnimate = () => typeof env.requestAnimationFrame === 'function' && (encrypted || !media?.matches);
	// Desktop uses subpixel compositor motion, not scrollLeft read/write on every
	// frame. Geometry changes only with text or a resize; don't remeasure a still strip.
	const measureTail = () => Math.max(0, (track.scrollWidth || 0) - (viewport.clientWidth || 0));
	const tail = () => desktop ? (desktopTail ??= measureTail()) : measureTail();
	const left = () => desktop ? desktopLeft : (viewport.scrollLeft || 0);
	const move = position => {
		if (desktop) {
			desktopLeft = Math.max(0, position);
			if (track.style) track.style.transform = `translate3d(${-desktopLeft}px, 0, 0)`;
		} else viewport.scrollLeft = position;
	};
	const mask = () => {
		const overflow = String(left() > 1);
		if (viewport.dataset.overflow !== overflow) viewport.dataset.overflow = overflow;
	};
	const releaseLayer = () => { if (desktop && track.style) track.style.willChange = originalWillChange; };
	const stop = () => {
		if (frame) env.cancelAnimationFrame?.(frame);
		frame = 0; previousTime = null; credit = 0;
		releaseLayer();
	};
	const writeText = text => {
		const node = track.firstChild;
		// Append to the existing desktop text node instead of rebuilding the
		// whole line for every character. Replacements/pruning still reset it.
		if (desktop && node?.nodeType === 3 && text.startsWith(node.data)) {
			if (text.length > node.data.length) node.appendData(text.slice(node.data.length));
		} else track.textContent = text;
		desktopTail = null;
	};
	const paint = () => {
		writeText(visible.join(''));
		// Keep the DOM strip bounded without shifting the reader's visible window.
		if (visible.length > 1024) {
			const before = track.scrollWidth || 0, position = left();
			visible = visible.slice(-768);
			writeText(visible.join(''));
			move(Math.max(0, position - (before - (track.scrollWidth || 0))));
		}
	};
	const primeEncryptedLine = () => {
		// Opaque text is activity feedback, not prose to reveal from an empty
		// line. Fill one measured viewport from the real prefix so desktop does
		// not spend several seconds typing before any leftward motion is visible.
		const width = viewport.clientWidth || 0;
		if (!width) return;
		let low = 0, high = Math.min(pending.length, 768);
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			track.textContent = pending.slice(0, mid).join('');
			if ((track.scrollWidth || 0) <= width) low = mid;
			else high = mid - 1;
		}
		visible = pending.slice(0, low); consumed = low;
	};
	const finishImmediately = () => {
		stop();
		visible = visible.concat(pending.slice(consumed));
		pending = []; consumed = 0;
		paint(); move(tail()); mask();
	};
	const tick = now => {
		frame = 0;
		if (disposed) return;
		const elapsed = previousTime === null ? 16 : Math.min(64, Math.max(0, now - previousTime));
		previousTime = now;
		const remaining = pending.length - consumed;
		if (remaining) {
			// Readable reasoning catches up after packet bursts. Opaque payloads
			// play at a steady rate regardless of backlog: 64 chars/s on desktop,
			// the existing 32 on phones, and half speed for reduced motion.
			const baseRate = desktop ? 64 : 32;
			credit += elapsed * (encrypted ? baseRate / (media?.matches ? 2 : 1) : Math.max(baseRate, remaining / (desktop ? .2 : .32))) / 1000;
			const count = Math.min(remaining, Math.floor(credit));
			if (count) {
				visible = visible.concat(pending.slice(consumed, consumed + count));
				consumed += count; credit -= count;
				paint();
			}
			if (consumed === pending.length) { pending = []; consumed = 0; credit = 0; }
		}
		const destination = tail(), distance = destination - left();
		move(Math.abs(distance) <= .5 ? destination : left() + distance * (1 - Math.exp(-elapsed / 55)));
		mask();
		if (pending.length > consumed || Math.abs(destination - left()) > .5) schedule();
		else { move(destination); mask(); previousTime = null; releaseLayer(); }
	};
	function schedule() {
		if (disposed) return;
		if (!canAnimate()) { finishImmediately(); return; }
		if (!frame) {
			if (desktop && track.style && track.style.willChange !== 'transform') track.style.willChange = 'transform';
			frame = env.requestAnimationFrame(tick);
		}
	}
	function update(value) {
		if (disposed) return;
		const text = String(typeof value === 'string' ? value : value?.text || '');
		const nextEncrypted = Boolean(value?.encrypted);
		if (text === target && nextEncrypted === encrypted) return;
		const reset = !target || !text.startsWith(target) || nextEncrypted !== encrypted;
		encrypted = nextEncrypted;
		if (reset) {
			stop(); pending = []; consumed = 0;
			target = text;
			if (encrypted && canAnimate()) {
				// Queue the full real payload, prefill only the first visible line,
				// then play sequentially at the device's rate without jumping to the tail.
				visible = []; pending = Array.from(text);
				primeEncryptedLine();
				paint(); move(0); mask();
				if (pending.length > consumed) schedule();
			} else {
				// Readable mount/reopen/replaced snapshots keep their current tail.
				visible = Array.from(text).slice(-768);
				paint(); move(tail()); mask();
			}
			return;
		}
		pending = pending.slice(consumed).concat(Array.from(text.slice(target.length)));
		consumed = 0; target = text;
		schedule();
	}
	const onMotionChange = () => schedule();
	const onDesktopChange = () => {
		if (disposed) return;
		const position = left();
		releaseLayer();
		if (desktop && track.style) track.style.transform = originalTransform;
		desktop = Boolean(desktopMedia?.matches); desktopTail = null;
		if (desktop) viewport.scrollLeft = 0;
		move(position); mask(); schedule();
	};
	media?.addEventListener?.('change', onMotionChange);
	desktopMedia?.addEventListener?.('change', onDesktopChange);
	const Observer = env.ResizeObserver || globalThis.ResizeObserver;
	const observer = typeof Observer === 'function' ? new Observer(() => { desktopTail = null; schedule(); }) : null;
	observer?.observe(viewport); observer?.observe(track);
	update(initialValue);
	return {
		update,
		sync: () => { desktopTail = null; schedule(); },
		dispose() {
			disposed = true; stop(); pending = []; consumed = 0; visible = []; target = '';
			observer?.disconnect(); media?.removeEventListener?.('change', onMotionChange);
			desktopMedia?.removeEventListener?.('change', onDesktopChange);
			if (desktop && track.style) { track.style.transform = originalTransform; track.style.willChange = originalWillChange; }
		},
	};
}

export const reasoningPreviewDirective = {
	mounted(el, {value}) { el._reasoningPreview = createReasoningPreview(el, value); },
	updated(el, {value}) { el._reasoningPreview?.update(value); },
	beforeUnmount(el) { el._reasoningPreview?.dispose(); delete el._reasoningPreview; },
};

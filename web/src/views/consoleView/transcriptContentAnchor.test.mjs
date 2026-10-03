import test from 'node:test';
import assert from 'node:assert/strict';
import {captureTranscriptContentAnchor, transcriptContentAnchorDelta, visibleTranscriptAnchorRoot} from './transcriptContentAnchor.js';

function fixture(count = 334, scroll = 10000) {
	let boxes = 0, textReads = 0;
	const walked = [];
	const doc = {
		createTreeWalker(root) {
			walked.push(root);
			const nodes = root === turn ? rows.map(row => row.text) : [root.text];
			let index = 0;
			return {nextNode: () => nodes[index++] || null};
		},
		createRange() {
			let node, start = 0, end = 1;
			return {
				selectNodeContents(value) { node = value; start = 0; end = node.textContent.length; },
				setStart(value, offset) { node = value; start = offset; },
				setEnd(value, offset) { node = value; end = offset; },
				getClientRects() { textReads++; return [node.row.rect()]; },
				getBoundingClientRect() {
					textReads++;
					const rect = node.row.rect();
					const top = rect.top + Math.floor(start / 10) * 20;
					const bottom = rect.top + Math.ceil(end / 10) * 20;
					return {top, bottom, height: bottom - top};
				},
			};
		},
	};
	const rows = Array.from({length: count}, (_, index) => {
		const row = {index, rect: () => ({top: index * 40 - scroll, bottom: index * 40 + 40 - scroll, height: 40}),
			getBoundingClientRect() { boxes++; return this.rect(); }, contains(node) { return node === this.text; }};
		row.text = {textContent: '01234567890123456789', row, ownerDocument: doc};
		return row;
	});
	const turn = {ownerDocument: doc, querySelectorAll: () => rows, contains: node => rows.some(row => row.contains(node))};
	return {turn, rows, walked, setScroll: value => {scroll = value;}, counts: () => ({boxes, textReads})};
}
const viewport = {top: 0, bottom: 600, height: 600};

test('a long turn reads text only in the visible row, not the 250 rows above it', () => {
	const f = fixture();
	const anchor = captureTranscriptContentAnchor(f.turn, viewport);
	assert.equal(anchor.node, f.rows[251].text);
	assert.deepEqual(f.walked, [f.rows[251]]);
	assert.ok(f.counts().boxes <= 12, 'binary search bounds geometry work');
	assert.ok(f.counts().textReads < 12, 'only one text row is measured');
	assert.equal(transcriptContentAnchorDelta(anchor, f.turn, viewport), 0);
});

test('scrolling to a different row never measures the now offscreen previous text anchor', () => {
	const f = fixture();
	const first = captureTranscriptContentAnchor(f.turn, viewport);
	f.setScroll(2000);
	const before = f.counts().textReads;
	const second = captureTranscriptContentAnchor(f.turn, viewport, first);
	assert.equal(second.node, f.rows[51].text);
	assert.ok(f.counts().textReads - before < 12);
	assert.equal(f.walked.at(-1), f.rows[51]);
});

test('unchanged character is reused and width/reflow movement can be compensated exactly', () => {
	const f = fixture();
	const first = captureTranscriptContentAnchor(f.turn, viewport);
	assert.equal(captureTranscriptContentAnchor(f.turn, viewport, first), first);
	f.setScroll(9980);
	assert.equal(transcriptContentAnchorDelta(first, f.turn, viewport), 20);
	f.setScroll(10000);
	assert.equal(transcriptContentAnchorDelta(first, f.turn, viewport), 0);
	assert.equal(transcriptContentAnchorDelta(first, {contains: () => false}, viewport), null);
});

test('no visible row returns no text anchor; legacy markup without rows keeps its original path', () => {
	const f = fixture(2, 1000);
	assert.equal(visibleTranscriptAnchorRoot(f.turn, viewport), null);
	assert.equal(captureTranscriptContentAnchor(f.turn, viewport), null);
	const legacy = {};
	assert.equal(visibleTranscriptAnchorRoot(legacy, viewport), legacy);
	assert.equal(captureTranscriptContentAnchor(legacy, viewport), null);
});

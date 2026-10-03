import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimelineReuse} from './timelineReuse.js';
import {projectOperationMessages, reduceOperationFrame} from '../../timelineProjection.js';

function operation(id, type, payload, extra = {}) {
	return {opId: id, opType: type, turnUuid: 'turn', runRootTurnId: 'turn', displaySeq: 1,
		createdAtMs: 1000, updatedAtMs: 2000, status: 'completed', lifecycle: 'terminal', revision: 1, payload, ...extra};
}
const user = operation('user', 'user_message', {text: 'start'});
const thought = operation('thought', 'reasoning', {text: 'old reasoning', complete: true}, {displaySeq: 2});
const tool = operation('tool', 'tool', {name: 'Read', arguments: '{"path":"file"}', resultText: 'unchanged'}, {displaySeq: 3, createdAtMs: 2000});
const live = operation('live', 'reasoning', {text: 'new'}, {displaySeq: 4, createdAtMs: 3000, status: 'running', lifecycle: 'active'});
const timeline = list => list.find(item => item.localTimeline).localTimeline;

test('stream update reuses old events, updates the live event, and leaves source snapshots untouched', () => {
	const reuse = createTimelineReuse();
	const ops = [user, thought, tool, live];
	const first = reuse(projectOperationMessages(ops));
	const changed = reduceOperationFrame(live, {opId: 'live', opType: 'reasoning', action: 'delta', revision: 2, payload: {delta: ' text'}});
	const expected = projectOperationMessages([user, thought, tool, changed]);
	const second = reuse(expected);
	assert.deepEqual(second, expected);
	assert.equal(first[0], second[0]);
	assert.equal(timeline(first)[0], timeline(second)[0]);
	assert.equal(timeline(first)[1], timeline(second)[1]);
	assert.notEqual(timeline(first)[2], timeline(second)[2]);
	assert.equal(live.payload.text, 'new');
	assert.equal(reuse(projectOperationMessages([user, thought, tool, changed])), second, 'identical output does not trigger another message update');
});

test('finishing reasoning with a new tool invalidates the affected reasoning but not older tools', () => {
	const reuse = createTimelineReuse();
	const first = reuse(projectOperationMessages([user, tool, live]));
	const nextTool = operation('next-tool', 'tool', {name: 'Bash'}, {displaySeq: 5, createdAtMs: 4000});
	const second = reuse(projectOperationMessages([user, tool, live, nextTool]));
	assert.equal(timeline(first)[0], timeline(second)[0]);
	assert.notEqual(timeline(first)[1], timeline(second)[1]);
	assert.equal(timeline(second)[1].reasoningActive, false);
	assert.equal(timeline(second)[1].reasoningEndedAtMs, 4000);
});

test('late Agent control changes its target even though the original Agent operation revision did not change', () => {
	const reuse = createTimelineReuse();
	const agent = operation('agent', 'agent', {taskUuid: 'task-one', task: {taskUuid: 'task-one', title: 'backend', status: 'running'}}, {displaySeq: 2});
	const initial = reuse(projectOperationMessages([user, agent, tool]));
	const control = operation('control', 'agent_control', {taskUuid: 'task-one', statusText: 'new instruction'}, {displaySeq: 4});
	const expected = projectOperationMessages([user, agent, tool, control]);
	const changed = reuse(expected);
	assert.deepEqual(changed, expected);
	assert.notEqual(timeline(changed)[0], timeline(initial)[0]);
	assert.equal(timeline(changed)[0].operation, timeline(initial)[0].operation);
	assert.equal(timeline(changed)[1], timeline(initial)[1]);
});

test('prepend/reorder retains keyed events; removed entries and another conversation cannot leak into the next snapshot', () => {
	const reuse = createTimelineReuse();
	const event = id => ({id, kind: 'tool', message: {content: id}});
	const first = reuse([{id: 't', events: [event('a'), event('b')]}]);
	const second = reuse([{id: 't', events: [event('older'), event('b'), event('a')]}]);
	assert.equal(second[0].events[1], first[0].events[1]);
	assert.equal(second[0].events[2], first[0].events[0]);
	assert.deepEqual(reuse([]), []);
	const restored = reuse([{id: 't', events: [event('a')]}]);
	assert.notEqual(restored[0].events[0], first[0].events[0]);
	assert.deepEqual(reuse([{id: 'other', events: [event('new')]}]), [{id: 'other', events: [event('new')]}]);
});

test('changed metadata, removed keys, tool revisions and retry state remain observable', () => {
	const reuse = createTimelineReuse();
	const first = reuse([{id: 't', events: [{id: 'e', operation: tool, live: true, retry: {active: true}}], stats: {durationMs: 1}}]);
	const changedOperation = {...tool, revision: 2};
	const expected = [{id: 't', events: [{id: 'e', operation: changedOperation, retry: {active: false}}], stats: {durationMs: 2}}];
	const second = reuse(expected);
	assert.deepEqual(second, expected);
	assert.notEqual(second[0], first[0]);
	assert.equal(second[0].events[0].operation, changedOperation);
	assert.equal(Object.hasOwn(second[0].events[0], 'live'), false);
});

test('non-monotonic later boundary still corrects the earliest reasoning end', () => {
	const a = operation('a', 'tool', {name: 'Read'}, {displaySeq: 3, createdAtMs: 9000});
	const b = operation('b', 'tool', {name: 'Read'}, {displaySeq: 4, createdAtMs: 3000});
	const c = operation('c', 'tool', {name: 'Read'}, {displaySeq: 5, createdAtMs: 8000});
	assert.equal(timeline(projectOperationMessages([user, thought, a, b, c]))[0].reasoningEndedAtMs, 3000);
});

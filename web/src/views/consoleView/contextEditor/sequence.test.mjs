import test from 'node:test';
import assert from 'node:assert/strict';
import {messageSequence, canMoveBlock, moveBlock, replaceBlock} from './sequence.js';
import {clone, deleteCall, nativeConflicts, reconcileMessage} from './operations.js';

const sample = () => ({role: 'assistant', content: 'beforeafter', reasoning: 'summary', tool_calls: [
  {id: 'c1', name: 'Read', arguments: '{}', vendor: 1}, {id: 'c2', name: 'Read', arguments: '{}'}], native_output_items: [
  {type: 'reasoning', summary: [{type: 'summary_text', text: 'summary'}], encrypted_content: 'opaque'},
  {type: 'message', id: 'm1', content: [{type: 'output_text', text: 'before', annotations: [{keep: 1}]}]},
  {type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}', status: 'completed'},
  {type: 'message', id: 'm2', content: [{type: 'output_text', text: 'after'}]},
  {type: 'function_call', call_id: 'c2', name: 'Read', arguments: '{}'}]});

test('native sequence follows stored order instead of grouping by type', () => {
  const m = sample(), seq = messageSequence(m);
  assert.equal(seq.ordered, true);
  assert.deepEqual(seq.rows.map(r => r.type), ['reasoning', 'message', 'function_call', 'message', 'function_call']);
  assert.deepEqual(seq.rows.map(r => r.preview), ['summary', 'before', '{}', 'after', '{}']);
  assert.equal(seq.rows.length, 5, 'neutral reasoning/body/calls must not duplicate native blocks');
});
test('moves reorder actual native data and neutral call projection without mutating the original', () => {
  const m = sample(), original = clone(m);
  let n = moveBlock(m, 'native-4', -1);
  n = moveBlock(n, 'native-3', -1);
  assert.deepEqual(n.tool_calls.map(c => c.id), ['c2', 'c1']);
  assert.equal(n.tool_calls[1].vendor, 1);
  assert.deepEqual(n.native_output_items.map(b => b.call_id || b.id || b.type), ['reasoning', 'm1', 'c2', 'c1', 'm2']);
  assert.deepEqual(n.native_output_items[0], m.native_output_items[0]);
  assert.deepEqual(nativeConflicts(n), []);
  assert.deepEqual(m, original);
  assert.equal(canMoveBlock(m, 'native-0', -1), false);
  assert.equal(canMoveBlock(m, 'native-4', 1), false);
  assert.throws(() => moveBlock(m, 'native-0', -1));
});
test('editing a call or deleting it does not collapse text before and after the call', () => {
  const m = sample(), changed = clone(m); changed.tool_calls[0].arguments = '{"path":"file"}';
  const n = reconcileMessage(m, changed);
  assert.deepEqual(n.native_output_items[1], m.native_output_items[1]);
  assert.deepEqual(n.native_output_items[3], m.native_output_items[3]);
  assert.equal(n.native_output_items[2].arguments, changed.tool_calls[0].arguments);
  const d = {entries: [{entryId: 'a', message: m}, {entryId: 'r1', message: {role: 'tool', tool_call_id: 'c1', content: 'ok'}}, {entryId: 'r2', message: {role: 'tool', tool_call_id: 'c2', content: 'ok'}}]};
  const result = deleteCall(d, 'a', 'c1');
  assert.deepEqual(result.entries[0].message.native_output_items.filter(b => b.type === 'message'), m.native_output_items.filter(b => b.type === 'message'));
  assert.deepEqual(result.entries.map(e => e.entryId), ['a', 'r2']);
});
test('individual block editing preserves siblings, opaque metadata and updates visible text', () => {
  const m = sample(), row = messageSequence(m).rows[3], value = clone(row.value); value.content[0].text = 'edited';
  const n = replaceBlock(m, row, value);
  assert.equal(n.content, 'beforeedited');
  assert.deepEqual(n.native_output_items.slice(0, 3), m.native_output_items.slice(0, 3));
  assert.deepEqual(nativeConflicts(n), []);
  assert.throws(() => replaceBlock(m, row, 'not an object'), /type/);
});
test('field-only and Anthropic snapshots do not invent a cross-type timeline', () => {
  const m = sample(); delete m.native_output_items;
  const seq = messageSequence(m); assert.equal(seq.ordered, false);
  assert.deepEqual(seq.rows.map(r => r.source), ['reasoning', 'content', 'tool_calls', 'tool_calls']);
  assert.equal(canMoveBlock(m, 'call-0', -1), false);
  assert.equal(canMoveBlock(m, 'call-0', 1), true);
  assert.deepEqual(moveBlock(m, 'call-0', 1).tool_calls.map(c => c.id), ['c2', 'c1']);
  m.native_output_items = [{type: 'thinking', thinking: 'signed', signature: 'sig'}, {type: 'redacted_thinking', data: 'cipher'}];
  const anthro = messageSequence(m); assert.equal(anthro.ordered, false);
  assert.deepEqual(anthro.rows.map(r => r.source), ['native_output_items', 'native_output_items', 'content', 'tool_calls', 'tool_calls']);
  assert.equal(canMoveBlock(m, 'native-1', 1), false);
  assert.equal(canMoveBlock(m, 'native-0', 1), true);
});

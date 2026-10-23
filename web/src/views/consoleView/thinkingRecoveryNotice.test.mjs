import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {compactAgentStepActivityLines, isActivityExcludedEventKind} from './agentPlanPresentation.js';

test('thinking recovery stays visible between a failed request and its successful retry', () => {
  const display = readFileSync(new URL('./display.js', import.meta.url), 'utf8');
  const source = display.slice(display.indexOf('export function recentEventMessage('), display.indexOf('\nfunction isAgentRecentActiveStatus('));
  const recentEventMessage = vm.runInNewContext(`${source.replace('export ', '')}\nrecentEventMessage;`);
  const summary = '上游拒绝复用与当前对话前缀不兼容的旧思考；已从活动上下文撤下旧思考，准备重试一次。正文、工具调用与已完成结果保留，原始历史未删除。';
  const notice = {key: 'recovery', seq: 3, kind: 'model_thinking_prefix_recovered', summary,
    detail: {scope: 'request_thinking', originalHistoryPreserved: true}};
  assert.equal(isActivityExcludedEventKind(notice.kind), false);
  assert.equal(recentEventMessage(notice), summary);
  const events = [
    {key: 'first', seq: 1, kind: 'model_call_started'},
    {key: 'rejected', seq: 2, kind: 'model_stream_interrupted'},
    notice,
    {key: 'second', seq: 4, kind: 'model_call_started'},
    {key: 'done', seq: 5, kind: 'model_call_finished'},
  ].map(event => ({...event, message: recentEventMessage(event)}));
  const visible = compactAgentStepActivityLines(events);
  const recovery = visible.filter(event => event.kind === notice.kind);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].message, summary);
  assert.equal(recovery[0].detail.originalHistoryPreserved, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {draftEnvironment, mountDraftConsole, settleDraftConsole, deferred} from './consoleDraftLifecycleHarness.mjs';

const forms = ['questionnaire', 'confirm', 'select', 'prompt'].map(action => ({confirmationId: `A-${action}`, action, revision: 1}));
function environment() {
  const env = draftEnvironment(), sockets = [], answers = [];
  const Socket = env.globals.WebSocket;
  env.globals.WebSocket = class extends Socket { constructor(...args) {super(...args); sockets.push(this);} };
  env.api.answerConversationConfirmation = async (...args) => {answers.push(args);};
  return {env, sockets, answers};
}
const receive = (socket, value) => socket.onmessage({data: JSON.stringify(value)});

for (const target of ['local:new', 'B']) test(`pending interactions leave the composer immediately when navigating to ${target}, and return only with A's bootstrap`, async () => {
  const {env, sockets, answers} = environment();
  const h = await mountDraftConsole(env, 'A');
  const gate = deferred();
  try {
    await settleDraftConsole();
    const outgoing = sockets.at(-1), lateMessage = outgoing.onmessage;
    receive(outgoing, {type: 'bootstrap', pendingConfirmations: forms});
    assert.equal(h.state.pendingConfirmations.length, 4);
    h.state.pendingInteractionFocus = {conversationUuid: 'A', interactionId: 'missing'};
    h.state.confirmationErrors = {'A-questionnaire': '旧错误'};
    h.state.confirmationSubmitting = {'A-confirm': true};
    if (target === 'B') env.api.conversationState = async () => gate.promise;
    else env.api.conversationDefaults = async () => gate.promise;
    h.update(target);
    await settleDraftConsole();
    assert.equal(h.state.pendingConfirmations.length, 0);
    assert.equal(h.state.pendingInteractionFocus, null);
    assert.equal(Object.keys(h.state.confirmationErrors).length, 0);
    assert.equal(Object.keys(h.state.confirmationSubmitting).length, 0);
    lateMessage({data: JSON.stringify({type: 'web_confirmation', confirmations: forms})});
    await h.state.answerPendingConfirmation(forms[0], {cancelled: true});
    assert.equal(h.state.pendingConfirmations.length, 0);
    assert.equal(answers.length, 0, 'navigation neither cancels nor answers the original form');
    gate.resolve(target === 'B' ? env.snapshot('B') : {defaults: {mainModel: 'test-model'}});
    await settleDraftConsole();
    assert.equal(h.state.pendingConfirmations.length, 0);
    env.api.conversationState = async uuid => env.snapshot(uuid);
    h.update('A');
    await settleDraftConsole();
    assert.equal(h.state.pendingConfirmations.length, 0);
    receive(sockets.at(-1), {type: 'bootstrap', pendingConfirmations: forms});
    assert.equal(h.state.pendingConfirmations.length, 4);
    assert.equal(answers.length, 0);
  } finally {gate.resolve(env.snapshot(target)); h.unmount(); env.cleanup();}
});

for (const outcome of ['success', 'invalid', 'expired']) test(`late ${outcome} submission cannot change B or a newer visit to A`, async () => {
  const {env, sockets, answers} = environment();
  const gate = deferred();
  env.api.answerConversationConfirmation = async (...args) => {
    answers.push(args);
    await gate.promise;
    if (outcome !== 'success') throw {response: {status: outcome === 'expired' ? 409 : 400, data: {error: outcome === 'expired' ? 'confirmation_expired' : 'invalid_answer'}}};
  };
  const h = await mountDraftConsole(env, 'A');
  try {
    await settleDraftConsole();
    receive(sockets.at(-1), {type: 'bootstrap', pendingConfirmations: forms});
    const answer = h.state.answerPendingConfirmation(h.state.pendingConfirmations[0], {answers: []});
    assert.equal(answers[0][0], 'A');
    h.update('B'); await settleDraftConsole();
    assert.equal(h.state.pendingConfirmations.length, 0);
    h.update('A'); await settleDraftConsole();
    receive(sockets.at(-1), {type: 'bootstrap', pendingConfirmations: forms});
    h.state.confirmationSubmitting = {'A-questionnaire': true};
    h.state.confirmationErrors = {'A-questionnaire': '本次访问的错误'};
    const activeRows = h.state.pendingConfirmations, activeErrors = h.state.confirmationErrors, activeSubmitting = h.state.confirmationSubmitting;
    gate.resolve(); await answer; await settleDraftConsole();
    assert.equal(h.state.pendingConfirmations, activeRows);
    assert.equal(h.state.confirmationErrors, activeErrors);
    assert.equal(h.state.confirmationSubmitting, activeSubmitting);
    assert.equal(answers.length, 1);
  } finally {gate.resolve(); h.unmount(); env.cleanup();}
});

test('current questionnaire answers retain the original conversation endpoint and clear only the answered card', async () => {
  const {env, sockets, answers} = environment();
  const h = await mountDraftConsole(env, 'A');
  try {
    await settleDraftConsole();
    receive(sockets.at(-1), {type: 'bootstrap', pendingConfirmations: forms});
    await h.state.answerPendingConfirmation(h.state.pendingConfirmations[0], {answers: [{questionId: 'q1', text: '保持原有回答'}]});
    assert.equal(answers[0][0], 'A');
    assert.equal(answers[0][1], 'A-questionnaire');
    assert.equal(answers[0][2].revision, 1);
    assert.equal(h.state.pendingConfirmations.length, 3);
    assert.equal(Object.keys(h.state.confirmationSubmitting).length, 0);
    assert.equal(Object.keys(h.state.confirmationErrors).length, 0);
  } finally {h.unmount(); env.cleanup();}
});

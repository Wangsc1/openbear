"""Trigger field errors must not inherit system-prompt empty-field semantics."""
import pytest

from app.memory.builtin import TemplateEngine
from app.webhooks.contracts import EndpointConfig, WebhookError
from app.webhooks.templates import render, validate_template
from tests.test_webhooks_backend import env


@pytest.mark.parametrize('expression,path', [('e.body.order.status','e.body.order.status'), ('e.body["status"]','e.body["status"]')])
async def test_A16_runtime_template_reports_nested_missing_field(env, expression, path):
    config=EndpointConfig.model_validate({'processing':{'eventTemplate':'@each e in events\n[['+expression+']]\n@endeach'}})
    with pytest.raises(WebhookError) as failure:
        render(config,[{'body':{'order':{}}}])
    missing=failure.value.payload
    assert missing['code']=='missing_template_field' and missing['details']['field']==path
    assert path in missing['message']


def test_A16_per_event_values_are_distinct_and_material_is_not_evaluated_recursively():
    config = EndpointConfig.model_validate({'processing': {'eventTemplate': '@each e in events\n[[e.body.appname]]: [[e.body.message]]\n@endeach'}})
    text = render(config, [{'body': {'appname': 'one', 'message': '[[conversation.private]]'}}, {'body': {'appname': 'two', 'message': 'separate'}}])
    assert text == 'one: [[conversation.private]]\ntwo: separate'


def test_A16_short_circuit_and_existing_system_prompt_semantics_are_preserved():
    config = EndpointConfig.model_validate({'processing': {'eventTemplate': '[[events.length]]\n@if False and conversation.absent\nnot rendered\n@endif'}})
    assert render(config, [{'body': {}}]) == '1'
    assert TemplateEngine().render('[[item.absent]]', {'item': {}}) == ''
    with pytest.raises(WebhookError): validate_template('[[events.__class__]]')
    with pytest.raises(WebhookError): validate_template('[[events.pop()]]')

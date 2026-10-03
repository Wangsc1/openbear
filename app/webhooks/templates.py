"""Restricted trigger variables using the existing non-recursive template engine."""
from __future__ import annotations

import ast
import re

from app.memory.builtin import TemplateEngine
from app.webhooks.contracts import WebhookError, dumps


def _template_field(value, name, path):
    try:
        # AttrDict deliberately returns '' for absent names in system prompts.
        # Event templates must instead identify the missing payload field.
        if isinstance(value, dict):
            if name == 'length': return len(value)
            return value[name]
        return getattr(value, name)
    except (KeyError, AttributeError):
        raise WebhookError('missing_template_field', '缺少模板字段：'+path, details={'field':path}) from None


class _TriggerFields(ast.NodeTransformer):
    def visit_Attribute(self, node):
        path=ast.unparse(node)
        value=self.visit(node.value)
        return ast.copy_location(ast.Call(func=ast.Name(id='__field__',ctx=ast.Load()),args=[value,ast.Constant(node.attr),ast.Constant(path)],keywords=[]),node)


class TriggerTemplate(TemplateEngine):
    # An indexed expression ends with its own ']' before the closing ']]'.
    _expr_re = re.compile(r'\[\[\s*(.*?)\s*\]\](?!\])')

    def _eval(self, expr, ctx):
        tree = ast.parse(self._translate_expr(expr), mode='eval')
        for node in ast.walk(tree):
            if isinstance(node, (ast.Call,ast.Lambda,ast.ListComp,ast.DictComp,ast.GeneratorExp,ast.NamedExpr)):
                raise WebhookError('invalid_template', '模板只支持触发器字段/确定表达式，不执行函数')
            if isinstance(node,ast.Attribute) and node.attr.startswith('_'):
                raise WebhookError('invalid_template', 'private attributes are unavailable')
            if isinstance(node,ast.Name) and (node.id.startswith('_') or node.id not in ctx):
                raise WebhookError('missing_template_field',details={'field':node.id})
        # Transform only after validating the original expression. Lookup stays
        # lazy, so short-circuited branches are not evaluated or misreported.
        tree=ast.fix_missing_locations(_TriggerFields().visit(tree))
        try: return eval(compile(tree,'<trigger-template>','eval'),{'__builtins__':{},'__field__':_template_field},ctx)
        except (KeyError,IndexError) as exc:
            raise WebhookError('missing_template_field','缺少模板字段：'+expr,details={'field':expr,'key':str(exc)}) from None

    def _interpolate(self,line,ctx):
        def repl(match):
            value=self._eval(match.group(1),ctx)
            return str(value if value is not None else '')
        return self._expr_re.sub(repl,line)


def validate_template(template):
    if template is None: return
    stack=[]
    variables={'trigger','batch','events','conversation','True','False','None'}
    expressions=TriggerTemplate._expr_re.findall(template)
    for line in template.splitlines():
        t=line.strip()
        if t.startswith('@each '):
            m=re.fullmatch(r'@each\s+(\w+)\s+in\s+(.+)',t)
            if not m: raise WebhookError('invalid_template')
            variables.add(m[1]); expressions.append(m[2]); stack.append('@endeach')
        elif t.startswith('@if '): expressions.append(t[4:]); stack.append('@endif')
        elif t=='@raw': stack.append('@endraw')
        elif t in ('@endeach','@endif','@endraw'):
            if not stack or stack.pop()!=t: raise WebhookError('invalid_template','unbalanced template block')
        elif t=='@else' and (not stack or stack[-1]!='@endif'): raise WebhookError('invalid_template')
        elif t.startswith('@secret'): raise WebhookError('invalid_template','全局秘密不属于触发器变量')
    if stack or template.count('[[')!=template.count(']]'): raise WebhookError('invalid_template','unclosed template expression')
    for expr in expressions:
        try: tree=ast.parse(TemplateEngine()._translate_expr(expr),mode='eval')
        except SyntaxError as e: raise WebhookError('invalid_template',str(e)) from None
        for n in ast.walk(tree):
            if isinstance(n,ast.Name) and n.id not in variables: raise WebhookError('invalid_template_variable',details={'field':n.id})
            if isinstance(n,(ast.Call,ast.Lambda,ast.ListComp,ast.DictComp,ast.GeneratorExp,ast.NamedExpr)) or isinstance(n,ast.Attribute) and n.attr.startswith('_'):
                raise WebhookError('invalid_template_expression')


def render(config,events,*,trigger=None,batch=None,conversation=None):
    if not config.processing.event_template: return dumps(events)
    try: return TriggerTemplate().render(config.processing.event_template,{'events':events,'trigger':trigger or {},'batch':batch or {},'conversation':conversation or {}})
    except WebhookError: raise
    except Exception as e: raise WebhookError('template_render_error',str(e)) from None


def validate_result_schema(schema):
    if schema is None: return
    try: from jsonschema.validators import validator_for
    except ImportError: raise WebhookError('schema_validator_unavailable','服务器缺少JSON Schema验证器；不能启用结构化结果协议',status=503) from None
    try: validator_for(schema).check_schema(schema)
    except Exception as e: raise WebhookError('invalid_result_schema',str(e)) from None
    def local_refs(value):
        if isinstance(value,dict):
            for key in ('$ref','$dynamicRef','$recursiveRef'):
                if key in value and not value[key].startswith('#'): raise WebhookError('remote_schema_reference_forbidden')
            for nested in value.values(): local_refs(nested)
        elif isinstance(value,list):
            for nested in value: local_refs(nested)
    local_refs(schema)


def check_result(schema,value):
    if schema is None: return
    validate_result_schema(schema)
    from jsonschema.validators import validator_for
    # Never resolve remote references from a result schema (network is not validation).
    def refs(x):
        if isinstance(x,dict):
            if '$ref' in x and not x['$ref'].startswith('#'): raise WebhookError('remote_schema_reference_forbidden')
            for v in x.values(): refs(v)
        elif isinstance(x,list):
            for v in x: refs(v)
    refs(schema)
    errors=list(validator_for(schema)(schema).iter_errors(value))
    if errors: raise WebhookError('invalid_structured_result',details={'errors':[e.message for e in errors[:20]]})

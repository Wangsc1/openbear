"""Optional per-root model-call guard; ordinary runs have no budget policy."""
from contextvars import ContextVar

_active = {}
_current = ContextVar('model_call_budget', default=None)


def bind(budget):
    _active[(id(budget.db), budget.root)] = budget
    return _current.set(budget)


def unbind(budget, token):
    _active.pop((id(budget.db), budget.root), None)
    _current.reset(token)


def current_budget():
    from app.runtime.lifecycle import current_session
    session = current_session()
    if session and session.store:
        return _active.get((id(session.store.db), session.root_turn_uuid))
    value = _current.get()
    return value if value and not value.closed else None

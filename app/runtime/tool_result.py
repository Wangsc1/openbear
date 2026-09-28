"""Structured outcome of a single tool dispatch (independent of tool registration)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class ToolOutcome:
    """Execution status and reported effects are separate from business success.

    A completed handler merely returned; it need not have achieved its goal.
    The default unknown values never assert success or lack of side effects.
    """

    content: str
    status: str = "unknown"  # completed | failed | denied | cancelled | unknown
    effect_state: str = "unknown"  # not_started | reported | unknown
    business_success: bool | None = None
    images: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

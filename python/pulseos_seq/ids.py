"""Element IDs: ``<seq>:<role>[.<event>][@<loop>=<i>,...]`` and ``<seq>:param.<name>``.

Roles and event names are chosen by the recipe, so IDs stay the same across rebuilds as long as
the recipe keeps those names. Loop indices are listed in loop-nesting order.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

NAME = r"[A-Za-z][A-Za-z0-9_]*"
_NAME_RE = re.compile(rf"^{NAME}$")
_ID_RE = re.compile(
    rf"^(?P<seq>{NAME}):(?P<role>{NAME})(?:\.(?P<event>{NAME}))?(?:@(?P<loop>{NAME}=\d+(?:,{NAME}=\d+)*))?$"
)

PARAM_ROLE = "param"


class ElementIdError(ValueError):
    """A string is not a valid element ID, or a name is not a valid ID segment."""


def check_name(kind: str, value: str) -> str:
    """Return ``value`` if it is a valid role, event, loop or sequence name; raise otherwise."""
    if not isinstance(value, str) or not _NAME_RE.match(value):
        raise ElementIdError(f'{kind} name "{value}" must match {NAME}')
    return value


@dataclass(frozen=True)
class ElementId:
    seq: str
    role: str
    event: str | None = None
    loop: tuple[tuple[str, int], ...] = field(default=())

    @property
    def is_param(self) -> bool:
        return self.role == PARAM_ROLE

    @property
    def is_instance(self) -> bool:
        return len(self.loop) > 0

    def role_level(self) -> "ElementId":
        """The same element without loop indices."""
        return ElementId(self.seq, self.role, self.event)

    def __str__(self) -> str:
        text = f"{self.seq}:{self.role}"
        if self.event is not None:
            text += f".{self.event}"
        if self.loop:
            text += "@" + ",".join(f"{name}={index}" for name, index in self.loop)
        return text


def parse(text: str) -> ElementId:
    """Parse an element ID string."""
    match = _ID_RE.match(text) if isinstance(text, str) else None
    if match is None:
        raise ElementIdError(f'"{text}" is not an element ID (<seq>:<role>[.<event>][@<loop>=<i>,...])')
    loop: list[tuple[str, int]] = []
    if match["loop"]:
        for part in match["loop"].split(","):
            name, index = part.split("=")
            if any(name == seen for seen, _ in loop):
                raise ElementIdError(f'"{text}" repeats loop "{name}"')
            loop.append((name, int(index)))
    element = ElementId(match["seq"], match["role"], match["event"], tuple(loop))
    if element.is_param and (element.event is None or element.loop):
        raise ElementIdError(f'"{text}": a parameter ID is <seq>:param.<name> with no loop indices')
    return element

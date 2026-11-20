"""Resolve element IDs against a sequence model, and across two revisions of it.

``resolve(model, id)`` answers ``ok`` with the element or ``gone``; it never answers with a different
element. ``resolve_between(old, new, id)`` additionally follows ``formerly=`` renames declared by the
newer recipe and reports whether the element's fingerprint changed.
"""

from __future__ import annotations

from typing import Any

from .ids import PARAM_ROLE, ElementId, parse
from .builder import MARKER_ROLE


def _loop_matches(loop: dict[str, int], wanted: tuple[tuple[str, int], ...]) -> bool:
    return list(loop.items()) == list(wanted)


def resolve(model: dict[str, Any], element_id: str | ElementId) -> dict[str, Any]:
    """Look up one element. Raises ``ElementIdError`` for malformed IDs."""
    eid = parse(element_id) if isinstance(element_id, str) else element_id
    text = str(eid)
    if eid.seq != model["seq"]:
        return {"status": "gone", "id": text, "reason": f'sequence is "{model["seq"]}", not "{eid.seq}"'}
    if eid.role == PARAM_ROLE:
        found = model["params"].get(eid.event)
        if found is not None:
            return {"status": "ok", "id": text, "kind": "param", "element": found}
        return {"status": "gone", "id": text, "reason": f'no parameter "{eid.event}"'}
    if eid.role == MARKER_ROLE:
        for marker in model["markers"]:
            if marker["id"] == text:
                return {"status": "ok", "id": text, "kind": "marker", "element": marker}
        return {"status": "gone", "id": text, "reason": f'no marker "{eid.event}"'}
    role = next((r for r in model["roles"] if r["role"] == eid.role), None)
    if role is None:
        return {"status": "gone", "id": text, "reason": f'no role "{eid.role}"'}
    if eid.event is not None and not any(e["name"] == eid.event for e in role["events"]):
        return {"status": "gone", "id": text, "reason": f'role "{eid.role}" has no event "{eid.event}"'}
    if not eid.is_instance:
        if eid.event is None:
            return {"status": "ok", "id": text, "kind": "role", "element": role}
        event = next(e for e in role["events"] if e["name"] == eid.event)
        return {"status": "ok", "id": text, "kind": "role-event", "element": {**event, "role": eid.role}}
    if eid.event is None:
        for block in model["blocks"]:
            if block["role"] == eid.role and _loop_matches(block["loop"], eid.loop):
                return {"status": "ok", "id": text, "kind": "block", "element": block}
    else:
        for event in model["events"]:
            if event["id"] == text:
                return {"status": "ok", "id": text, "kind": "event", "element": event}
    return {"status": "gone", "id": text, "reason": "no instance with these loop indices"}


def _renamed_role(model: dict[str, Any], old_role: str) -> str | None:
    for role in model["roles"]:
        if role.get("formerly") == old_role:
            return role["role"]
    return None


def resolve_between(old: dict[str, Any], new: dict[str, Any], element_id: str) -> dict[str, Any]:
    """Resolve ``element_id`` (valid in ``old``) in ``new``: ``same``, ``changed``, ``renamed`` or ``gone``."""
    eid = parse(element_id)
    before = resolve(old, eid)
    after = resolve(new, eid)
    renamed_to = None
    if after["status"] == "gone" and eid.role not in (PARAM_ROLE, MARKER_ROLE):
        target = _renamed_role(new, eid.role)
        if target is not None:
            renamed_to = ElementId(eid.seq, target, eid.event, eid.loop)
            after = resolve(new, renamed_to)
    if after["status"] == "gone":
        return {"status": "gone", "id": element_id, "reason": after["reason"]}
    changed = before["status"] != "ok" or before["element"].get("fingerprint") != after["element"].get("fingerprint")
    result = {"status": "changed" if changed else "same", "id": after["id"], "element": after["element"]}
    if renamed_to is not None:
        result["renamedFrom"] = element_id
    return result


def role_diff(old: dict[str, Any], new: dict[str, Any]) -> dict[str, list[str]]:
    """Roles added, removed, renamed (``old->new``), changed and unchanged between two models."""
    old_roles = {r["role"]: r for r in old["roles"]}
    new_roles = {r["role"]: r for r in new["roles"]}
    renamed = {r["formerly"]: name for name, r in new_roles.items()
               if r.get("formerly") in old_roles and r.get("formerly") not in new_roles}
    diff: dict[str, list[str]] = {"added": [], "removed": [], "renamed": [], "changed": [], "same": []}
    for name, role in new_roles.items():
        source = next((o for o, n in renamed.items() if n == name), name)
        if source not in old_roles:
            diff["added"].append(name)
            continue
        if source != name:
            diff["renamed"].append(f"{source}->{name}")
        key = "same" if old_roles[source]["fingerprint"] == role["fingerprint"] else "changed"
        diff[key].append(name)
    diff["removed"] = [name for name in old_roles if name not in new_roles and name not in renamed]
    return diff

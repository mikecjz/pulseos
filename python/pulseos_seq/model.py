"""Build the sequence model JSON (schema ``pulseos.sequence/1``) from builder records.

Units in the model: time s, gradient amplitude mT/m, RF magnitude uT, phase rad, angles deg.
Fingerprints exclude absolute start times, so moving an unchanged element in time (e.g. a longer
TR before it) does not mark it changed; its duration, delay within the block and content do.
"""

from __future__ import annotations

from importlib.metadata import version
from typing import Any

import pypulseq as pp

from .builder import BlockRecord, BuilderRecords, MARKER_ROLE, Param, Params
from .canonical import digest
from .ids import PARAM_ROLE, ElementId

SCHEMA = "pulseos.sequence/1"


def _loop_json(loop: tuple[tuple[str, int], ...]) -> dict[str, int]:
    return {name: index for name, index in loop}


def _event_fingerprint(content: dict[str, Any]) -> str:
    return digest(content)


def _block_fingerprint(block: BlockRecord) -> str:
    return digest({"duration": block.duration,
                   "events": {e.name: _event_fingerprint(e.content) for e in block.events}})


def timing_report(seq: pp.Sequence, blocks: list[BlockRecord], seq_name: str) -> dict[str, Any]:
    """Run pypulseq's timing check and map each error to the element IDs of its block."""
    from pypulseq.check_timing import error_messages

    ok, report = seq.check_timing()
    by_index = {b.index: b for b in blocks}
    errors = []
    for entry in report:
        block = by_index.get(entry.block)
        ids: list[str] = []
        if block is not None:
            block_id = ElementId(seq_name, block.role, None, block.loop)
            ids.append(str(block_id))
            channel = {"rf": "rf", "gx": "gx", "gy": "gy", "gz": "gz", "adc": "adc"}.get(entry.event)
            for event in block.events:
                if event.channel == channel:
                    ids.insert(0, str(ElementId(seq_name, block.role, event.name, block.loop)))
        fields = dict(vars(entry))
        try:
            message = error_messages[entry.error_type].format(**fields) if entry.error_type in error_messages else entry.error_type
        except Exception:  # a template field missing from this entry; keep the raw type
            message = entry.error_type
        errors.append({"block": entry.block, "ids": ids, "errorType": entry.error_type,
                       "event": entry.event, "field": entry.field, "message": message})
    return {"ok": bool(ok), "errors": errors}


def build_model(*, seq_name: str, seq: pp.Sequence, records: BuilderRecords, declared: dict[str, Param],
                params: Params, profile: dict[str, Any], recipe_hash: str, recipe_file: str | None) -> dict[str, Any]:
    blocks_json = []
    events_json = []
    role_instances: dict[str, list[tuple[dict[str, int], str]]] = {}
    role_event_instances: dict[tuple[str, str], list[tuple[dict[str, int], str]]] = {}
    roles: dict[str, dict[str, Any]] = {}
    for block in records.blocks:
        loop = _loop_json(block.loop)
        block_fp = _block_fingerprint(block)
        blocks_json.append({
            "id": str(ElementId(seq_name, block.role, None, block.loop)),
            "index": block.index, "role": block.role, "loop": loop,
            "t0": block.t0, "duration": block.duration, "fingerprint": block_fp,
        })
        role = roles.setdefault(block.role, {
            "role": block.role, "id": f"{seq_name}:{block.role}", "events": {},
            "sourceSpan": block.span.to_json() if block.span else None,
            "formerly": block.formerly, "instances": 0,
        })
        role["instances"] += 1
        role_instances.setdefault(block.role, []).append((loop, block_fp))
        for event in block.events:
            fp = _event_fingerprint(event.content)
            role["events"].setdefault(event.name, {"name": event.name, "channel": event.channel,
                                                  "id": f"{seq_name}:{block.role}.{event.name}"})
            role_event_instances.setdefault((block.role, event.name), []).append((loop, fp))
            events_json.append({
                "id": str(ElementId(seq_name, block.role, event.name, block.loop)),
                "block": block.index, "role": block.role, "name": event.name, "channel": event.channel,
                "loop": loop, "t0": event.t0, "fingerprint": fp, **event.content,
            })
    for name, role in roles.items():
        role["fingerprint"] = digest(role_instances[name])
        role["events"] = list(role["events"].values())
        for event in role["events"]:
            event["fingerprint"] = digest(role_event_instances[(name, event["name"])])
            event["instances"] = len(role_event_instances[(name, event["name"])])

    values = params.as_dict()
    params_json = {
        name: {"id": f"{seq_name}:{PARAM_ROLE}.{name}", "value": values[name], "default": spec.default,
               "unit": spec.unit, "description": spec.description, "min": spec.min, "max": spec.max,
               "integer": spec.integer, "fingerprint": digest(values[name])}
        for name, spec in declared.items()
    }
    markers = []
    for marker in records.markers:
        role = PARAM_ROLE if marker.name in declared else MARKER_ROLE
        markers.append({"id": f"{seq_name}:{role}.{marker.name}", "name": marker.name, "t": marker.t, "start": marker.start,
                        "loop": _loop_json(marker.loop)})

    shapes = {sid: {"t": s.t, "value": s.value, **({"phase": s.phase} if s.phase is not None else {})}
              for sid, s in records.shapes.items()}
    total = sum(b.duration for b in records.blocks)
    return {
        "schema": SCHEMA,
        "seq": seq_name,
        "recipe": {"hash": recipe_hash, "file": recipe_file},
        "pypulseqVersion": version("pypulseq"),
        "profile": profile,
        "params": params_json,
        "duration": total,
        "loops": [{"name": n, "size": s} for n, s in records.loops.items()],
        "roles": list(roles.values()),
        "blocks": blocks_json,
        "events": events_json,
        "markers": markers,
        "shapes": shapes,
        "timing": timing_report(seq, records.blocks, seq_name),
    }

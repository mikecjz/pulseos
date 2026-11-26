"""Derive element roles for a pypulseq ``Sequence`` that was not built with ``SeqBuilder``.

Sequences from pypulseq's example scripts or from a ``.seq`` file carry no role names, so blocks
are grouped by what they contain:

* the base name comes from the block's events: the RF pulse's ``use`` (``excitation``,
  ``refocusing``, ``inversion``, ...), else ``readout`` for an ADC, else ``grad_<axes>`` for
  gradients only (``grad_xyz``), else ``trigger`` or ``delay``;
* blocks with the same base name but different event channels, kinds or durations are different
  roles, numbered in order of first appearance (``grad_xyz``, ``grad_xyz_2``); amplitudes may vary,
  so phase-encode steps or radial spokes stay one role;
* loop ``rep`` counts repetitions, each starting at an excitation pulse (or, without excitation
  pulses, at the first RF role); a role that occurs more than once in one repetition also gets the
  inner loop ``n``, its occurrence within the repetition.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pypulseq as pp

REPETITION_LOOP = "rep"
INNER_LOOP = "n"
RF_USES = ("excitation", "refocusing", "inversion", "saturation", "preparation")
CHANNELS = ("rf", "gx", "gy", "gz", "adc")


@dataclass
class DerivedBlock:
    index: int
    block: SimpleNamespace
    events: list[tuple[str, Any]]  # (channel, pypulseq event) for rf, gx, gy, gz, adc
    role: str
    rep: int
    n: int | None


def _duration(channel: str, obj: Any) -> float:
    if channel == "rf":
        return float(getattr(obj, "shape_dur", obj.t[-1] if len(obj.t) else 0.0))
    if channel == "adc":
        return float(obj.num_samples * obj.dwell)
    if obj.type == "trap":
        return float(obj.rise_time + obj.flat_time + obj.fall_time)
    return float(getattr(obj, "shape_dur", obj.tt[-1] if len(obj.tt) else 0.0))


def _base(events: list[tuple[str, Any]], block: SimpleNamespace) -> str:
    channels = {channel: obj for channel, obj in events}
    if "rf" in channels:
        use = str(getattr(channels["rf"], "use", "undefined"))
        return use if use in RF_USES else "rf"
    if "adc" in channels:
        return "readout"
    axes = "".join(sorted(channel[1] for channel in channels))
    if axes:
        return f"grad_{axes}"
    if getattr(block, "trigger", None):
        return "trigger"
    return "delay"


def _signature(base: str, events: list[tuple[str, Any]]) -> tuple[Any, ...]:
    return (base, *((channel, getattr(obj, "type", channel), round(_duration(channel, obj), 7)) for channel, obj in events))


def derive_roles(seq: pp.Sequence) -> Iterator[DerivedBlock]:
    """Yield every block of ``seq`` in order with its derived role and loop indices."""
    names: dict[tuple[Any, ...], str] = {}
    used: dict[str, int] = {}
    blocks: list[DerivedBlock] = []
    for index in sorted(seq.block_events):
        block = seq.get_block(index)
        events = [(channel, getattr(block, channel)) for channel in CHANNELS if getattr(block, channel, None) is not None]
        base = _base(events, block)
        signature = _signature(base, events)
        role = names.get(signature)
        if role is None:
            used[base] = used.get(base, 0) + 1
            role = base if used[base] == 1 else f"{base}_{used[base]}"
            names[signature] = role
        blocks.append(DerivedBlock(int(index), block, events, role, 0, None))

    if any(b.role.startswith("excitation") for b in blocks):
        starts = lambda b: b.role.split("_")[0] == "excitation"  # noqa: E731
    else:
        first_rf = next((b.role for b in blocks if any(channel == "rf" for channel, _ in b.events)), None)
        starts = lambda b: b.role == first_rf  # noqa: E731
    rep = -1
    counts: dict[tuple[str, int], int] = {}
    for b in blocks:
        if starts(b):
            rep += 1
        b.rep = max(rep, 0)
        key = (b.role, b.rep)
        b.n = counts.get(key, 0)
        counts[key] = b.n + 1
    repeated = {role for (role, _), count in counts.items() if count > 1}
    for b in blocks:
        if b.role not in repeated:
            b.n = None
        yield b

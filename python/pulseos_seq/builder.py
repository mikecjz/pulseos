"""``SeqBuilder``: the API recipes use to add pypulseq blocks under stable, recipe-chosen names.

Every block is added through :meth:`SeqBuilder.block` with a *role* name and named events. The
builder records, at the moment of the call, each event's timing and content, the active loop
indices, and the recipe source lines of the call. :mod:`pulseos_seq.model` turns those records into
the sequence model JSON.
"""

from __future__ import annotations

import inspect
import math
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import numpy as np
import pypulseq as pp

from .ids import PARAM_ROLE, check_name

MARKER_ROLE = "marker"
RESERVED_ROLES = {PARAM_ROLE, MARKER_ROLE}


class BuildError(Exception):
    """A recipe used the builder incorrectly. ``line`` is the recipe line when known."""

    def __init__(self, message: str, line: int | None = None):
        super().__init__(message)
        self.line = line


@dataclass(frozen=True)
class Param:
    """A recipe parameter: default value, unit, description and optional bounds."""

    default: float | int
    unit: str = ""
    description: str = ""
    min: float | None = None
    max: float | None = None
    integer: bool = False

    def check(self, name: str, value: Any) -> float | int:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise BuildError(f"parameter {name} must be a finite number, got {value!r}")
        if self.integer:
            if float(value) != int(value):
                raise BuildError(f"parameter {name} must be an integer, got {value!r}")
            value = int(value)
        else:
            value = float(value)
        if self.min is not None and value < self.min:
            raise BuildError(f"parameter {name} = {value} is below its minimum {self.min}")
        if self.max is not None and value > self.max:
            raise BuildError(f"parameter {name} = {value} is above its maximum {self.max}")
        return value


def param(default: float | int, unit: str = "", description: str = "", *, min: float | None = None,
          max: float | None = None, integer: bool = False) -> Param:
    """Declare a recipe parameter."""
    return Param(default, unit, description, min, max, integer)


class Params:
    """Resolved parameter values, readable as attributes (``p.TE``) or items (``p["TE"]``)."""

    def __init__(self, values: dict[str, float | int]):
        object.__setattr__(self, "_values", dict(values))

    def __getattr__(self, name: str) -> float | int:
        try:
            return self._values[name]
        except KeyError:
            raise AttributeError(f"unknown parameter {name}") from None

    def __getitem__(self, name: str) -> float | int:
        return self._values[name]

    def __setattr__(self, name: str, value: Any) -> None:
        raise BuildError("parameters are read-only inside build(); change them through the params request")

    def as_dict(self) -> dict[str, float | int]:
        return dict(self._values)


def resolve_params(declared: dict[str, Param], overrides: dict[str, Any] | None,
                   base: dict[str, Any] | None = None) -> Params:
    """Apply ``base`` then ``overrides`` to the declared defaults.

    Unknown names in ``overrides`` fail; names in ``base`` that the recipe no longer declares are
    ignored (``base`` carries the previous revision's values across a recipe edit). Every applied
    value is range-checked.
    """
    if not isinstance(declared, dict) or not all(isinstance(v, Param) for v in declared.values()):
        raise BuildError("PARAMS must be a dict of name -> param(...)")
    for name in declared:
        check_name("parameter", name)
    overrides = overrides or {}
    unknown = sorted(set(overrides) - set(declared))
    if unknown:
        raise BuildError(f"unknown parameter(s): {', '.join(unknown)}; declared: {', '.join(declared)}")
    inherited = {k: v for k, v in (base or {}).items() if k in declared}
    merged = {**inherited, **overrides}
    values = {name: spec.check(name, merged.get(name, spec.default)) for name, spec in declared.items()}
    return Params(values)


@dataclass(frozen=True)
class SourceSpan:
    start_line: int
    end_line: int

    def to_json(self) -> dict[str, int]:
        return {"startLine": self.start_line, "endLine": self.end_line}


@dataclass
class EventRecord:
    name: str
    channel: str  # rf | gx | gy | gz | adc
    t0: float  # absolute start of the active part, s
    content: dict[str, Any]  # unit-converted description; excludes absolute time


@dataclass
class BlockRecord:
    index: int
    role: str
    loop: tuple[tuple[str, int], ...]
    t0: float
    duration: float
    events: list[EventRecord]
    span: SourceSpan | None
    formerly: str | None


@dataclass
class MarkerRecord:
    name: str
    t: float
    start: float | None
    loop: tuple[tuple[str, int], ...]


@dataclass
class Shape:
    t: list[float]
    value: list[float]
    phase: list[float] | None = None


@dataclass
class BuilderRecords:
    blocks: list[BlockRecord] = field(default_factory=list)
    markers: list[MarkerRecord] = field(default_factory=list)
    loops: dict[str, int] = field(default_factory=dict)  # loop name -> size, in first-seen order
    inner_loops: set[str] = field(default_factory=set)  # loops that index blocks within one repetition
    shapes: dict[str, Shape] = field(default_factory=dict)


GRAD_CHANNELS = {"x": "gx", "y": "gy", "z": "gz"}


class SeqBuilder:
    """Adds tagged blocks to a pypulseq ``Sequence``."""

    def __init__(self, seq_name: str, system: pp.Opts, params: Params, recipe_file: str | None = None):
        self.name = check_name("sequence", seq_name)
        self.system = system
        self.p = params
        self.seq = pp.Sequence(system=system)
        self.records = BuilderRecords()
        self._recipe_file = recipe_file
        self._loop_stack: list[tuple[str, int]] = []
        self._t = 0.0
        self._role_spans: dict[str, SourceSpan | None] = {}
        self._role_formerly: dict[str, str | None] = {}
        self._seen: set[tuple[str, tuple[tuple[str, int], ...]]] = set()

    # -- loops --------------------------------------------------------------------------------
    def loop(self, name: str, values: Iterable[Any]) -> Iterator[Any]:
        """Iterate ``values`` with loop index ``name`` active; instance IDs carry ``@name=<i>``."""
        check_name("loop", name)
        if any(active == name for active, _ in self._loop_stack):
            raise BuildError(f'loop "{name}" is already active', self._caller_line())
        items = list(values)
        size = self.records.loops.get(name)
        self.records.loops[name] = max(size or 0, len(items))
        for index, value in enumerate(items):
            self._loop_stack.append((name, index))
            try:
                yield value
            finally:
                self._loop_stack.pop()

    # -- time ---------------------------------------------------------------------------------
    def now(self) -> float:
        """Sequence time at the end of the last added block, in seconds."""
        return self._t

    def mark(self, name: str, t: float, start: float | None = None) -> None:
        """Record a named timing marker at absolute time ``t``, optionally measured from ``start``.

        ``b.mark("TE", echo_centre, start=excitation_centre)`` draws TE as an interval.
        """
        check_name("marker", name)
        self.records.markers.append(MarkerRecord(name, float(t), None if start is None else float(start),
                                                 tuple(self._loop_stack)))

    # -- blocks -------------------------------------------------------------------------------
    def block(self, role: str, *, formerly: str | None = None, **events: SimpleNamespace | None) -> None:
        """Add one pypulseq block.

        ``role`` names what the block does (``excitation``, ``readout``); each keyword names one
        event (``rf=rf, gz=gz``). ``None`` events are skipped. ``formerly`` declares that this role
        was renamed from an earlier role name, so references to the old name keep resolving.
        """
        span = self._caller_span()
        line = span.start_line if span else None
        check_name("role", role)
        if role in RESERVED_ROLES:
            raise BuildError(f'role name "{role}" is reserved', line)
        if formerly is not None:
            check_name("role", formerly)
        if role in self._role_spans and self._role_spans[role] != span:
            first = self._role_spans[role]
            raise BuildError(f'role "{role}" is added from two places in the recipe '
                             f"(line {first.start_line if first else '?'} and line {line}); "
                             f"each role must come from one b.block call", line)
        key = (role, tuple(self._loop_stack))
        if key in self._seen:
            where = ", ".join(f"{n}={i}" for n, i in self._loop_stack) or "outside any loop"
            raise BuildError(f'role "{role}" is added twice for the same loop indices ({where}); '
                             f"use b.loop(...) for repetitions", line)
        self._seen.add(key)
        self._role_spans[role] = span
        if self._role_formerly.setdefault(role, formerly) != formerly:
            raise BuildError(f'role "{role}" declares different formerly= values', line)

        objects: list[SimpleNamespace] = []
        described: list[tuple[str, str, SimpleNamespace]] = []
        channels: dict[str, str] = {}
        for event_name, obj in events.items():
            if obj is None:
                continue
            check_name("event", event_name)
            channel = self._channel(obj, event_name, line)
            objects.append(obj)
            if channel is None:
                continue
            if channel in channels:
                raise BuildError(f'events "{channels[channel]}" and "{event_name}" both use channel {channel}', line)
            channels[channel] = event_name
            described.append((event_name, channel, obj))
        if not objects:
            raise BuildError(f'block "{role}" has no events', line)

        t0 = self._t
        try:
            self.seq.add_block(*objects)
        except Exception as error:  # pypulseq validation errors are plain Exceptions
            raise BuildError(f'pypulseq rejected block "{role}": {error}', line) from error
        index = len(self.seq.block_events)
        duration = float(self.seq.block_durations[index])
        records = [self._describe(name, channel, obj, t0) for name, channel, obj in described]
        self.records.blocks.append(BlockRecord(index, role, key[1], t0, duration, records, span, formerly))
        self._t = t0 + duration

    # -- whole sequences ----------------------------------------------------------------------
    def adopt(self, seq: pp.Sequence) -> None:
        """Use a complete pypulseq ``Sequence`` built elsewhere as this builder's sequence.

        For sequences written without the builder, such as pypulseq's example scripts or a ``.seq``
        file. Roles are derived from block contents (see :func:`pulseos_seq.adopt.derive_roles`):
        the first excitation of each repetition starts loop ``rep``, and a role that occurs more than
        once in one repetition also gets the inner loop ``n``. Blocks are recorded as they are; the
        builder adds nothing to the sequence.
        """
        from .adopt import INNER_LOOP, REPETITION_LOOP, derive_roles

        if self.records.blocks:
            raise BuildError("adopt() must be the only way blocks are added", self._caller_line())
        if not isinstance(seq, pp.Sequence):
            raise BuildError(f"adopt() needs a pypulseq Sequence, got {type(seq).__name__}", self._caller_line())
        self.seq = seq
        self.system = seq.system
        t = 0.0
        for item in derive_roles(seq):
            loop = ((REPETITION_LOOP, item.rep),) + (((INNER_LOOP, item.n),) if item.n is not None else ())
            for name, index in loop:
                self.records.loops[name] = max(self.records.loops.get(name, 0), index + 1)
            if item.n is not None:
                self.records.inner_loops.add(INNER_LOOP)
            events = [self._describe(channel, channel, obj, t) for channel, obj in item.events]
            duration = float(item.block.block_duration)
            self.records.blocks.append(BlockRecord(item.index, item.role, loop, t, duration, events, None, None))
            t += duration
        self._t = t

    # -- internals ----------------------------------------------------------------------------
    def _channel(self, obj: SimpleNamespace, name: str, line: int | None) -> str | None:
        kind = getattr(obj, "type", None)
        if kind == "rf":
            return "rf"
        if kind in ("trap", "grad"):
            return GRAD_CHANNELS[obj.channel]
        if kind == "adc":
            return "adc"
        if kind in ("delay", "labelset", "labelinc", "output", "trigger", "soft_delay", "rf_shim"):
            return None
        raise BuildError(f'event "{name}" is not a pypulseq event (type {kind!r})', line)

    def _shape(self, t: np.ndarray, value: np.ndarray, phase: np.ndarray | None = None) -> str:
        from .canonical import digest

        shape = Shape([float(x) for x in t], [float(x) for x in value],
                      None if phase is None else [float(x) for x in phase])
        shape_id = "shape:" + digest([shape.t, shape.value, shape.phase])[7:23]
        self.records.shapes.setdefault(shape_id, shape)
        return shape_id

    def _describe(self, name: str, channel: str, obj: SimpleNamespace, block_t0: float) -> EventRecord:
        gamma = self.system.gamma
        delay = float(getattr(obj, "delay", 0.0))
        if channel == "rf":
            t = np.asarray(obj.t, dtype=float)
            signal = np.asarray(obj.signal, dtype=complex)
            magnitude_uT = np.abs(signal) / gamma * 1e6
            phase = np.angle(signal)
            flip_rad = abs(np.trapezoid(signal, t)) * 2 * math.pi if len(t) > 1 else 0.0
            duration = float(getattr(obj, "shape_dur", t[-1] if len(t) else 0.0))
            content = {
                "kind": "rf", "delay": delay, "duration": duration,
                "shape": self._shape(t, magnitude_uT, phase),
                "peak": float(magnitude_uT.max()) if len(t) else 0.0, "peakUnit": "uT",
                "flipAngle": math.degrees(flip_rad),
                "freqOffset": float(obj.freq_offset), "phaseOffset": float(obj.phase_offset),
                "use": str(getattr(obj, "use", "undefined")),
            }
        elif obj.type == "trap":
            amplitude = float(obj.amplitude) / gamma * 1e3
            rise, flat, fall = float(obj.rise_time), float(obj.flat_time), float(obj.fall_time)
            content = {
                "kind": "trap", "delay": delay, "duration": rise + flat + fall,
                "amplitude": amplitude, "amplitudeUnit": "mT/m",
                "rise": rise, "flat": flat, "fall": fall,
                "area": float(obj.area), "areaUnit": "1/m",
            }
        elif obj.type == "grad":
            tt = np.asarray(obj.tt, dtype=float)
            waveform = np.asarray(obj.waveform, dtype=float) / gamma * 1e3
            duration = float(getattr(obj, "shape_dur", tt[-1] if len(tt) else 0.0))
            content = {
                "kind": "grad", "delay": delay, "duration": duration,
                "shape": self._shape(tt, waveform),
                "peak": float(np.abs(waveform).max()) if len(tt) else 0.0, "peakUnit": "mT/m",
                "area": float(obj.area), "areaUnit": "1/m",
            }
        else:  # adc
            samples = int(obj.num_samples)
            dwell = float(obj.dwell)
            content = {
                "kind": "adc", "delay": delay, "duration": samples * dwell,
                "numSamples": samples, "dwell": dwell,
                "freqOffset": float(obj.freq_offset), "phaseOffset": float(obj.phase_offset),
            }
        return EventRecord(name, channel, block_t0 + delay, content)

    def _recipe_frame(self) -> Any:
        frame = inspect.currentframe()
        while frame is not None:
            if self._recipe_file is not None and frame.f_code.co_filename == self._recipe_file:
                return frame
            frame = frame.f_back
        return None

    def _caller_span(self) -> SourceSpan | None:
        frame = self._recipe_frame()
        if frame is None:
            return None
        positions = inspect.getframeinfo(frame).positions
        start = positions.lineno if positions and positions.lineno else frame.f_lineno
        end = positions.end_lineno if positions and positions.end_lineno else start
        return SourceSpan(start, end)

    def _caller_line(self) -> int | None:
        span = self._caller_span()
        return span.start_line if span else None

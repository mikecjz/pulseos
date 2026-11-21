"""Scanner profiles: hardware limits shared with the DSH ``@pulseos/scanner-profile`` plugin.

A profile is ``<directory>/<id>.json``; see ``profiles/scanner/README.md`` for the fields.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, fields
from pathlib import Path

import pypulseq as pp

BUNDLED_PROFILE_DIRECTORY = Path(__file__).resolve().parents[2] / "profiles" / "scanner"

_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
_NON_NEGATIVE = {"rf_dead_time_s", "rf_ringdown_time_s", "adc_dead_time_s"}


@dataclass(frozen=True)
class ScannerLimits:
    """Hardware limits and raster times; units are part of each field name."""

    b0_T: float
    max_grad_mT_per_m: float
    max_slew_T_per_m_per_s: float
    grad_raster_time_s: float
    rf_raster_time_s: float
    adc_raster_time_s: float
    block_duration_raster_s: float
    rf_dead_time_s: float
    rf_ringdown_time_s: float
    adc_dead_time_s: float


@dataclass(frozen=True)
class ScannerProfile:
    id: str
    title: str
    limits: ScannerLimits
    description: str | None = None


class ScannerProfileError(ValueError):
    """The profile file is missing, malformed, or violates a field rule."""


def _limits(raw: object, where: str) -> ScannerLimits:
    if not isinstance(raw, dict):
        raise ScannerProfileError(f"{where}: limits must be an object")
    names = [f.name for f in fields(ScannerLimits)]
    unknown = sorted(set(raw) - set(names))
    missing = [name for name in names if name not in raw]
    if unknown:
        raise ScannerProfileError(f"{where}: unknown limit(s) {', '.join(unknown)}")
    if missing:
        raise ScannerProfileError(f"{where}: missing limit(s) {', '.join(missing)}")
    values: dict[str, float] = {}
    for name in names:
        value = raw[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ScannerProfileError(f"{where}: {name} must be a finite number")
        if value < 0 or (value == 0 and name not in _NON_NEGATIVE):
            raise ScannerProfileError(f"{where}: {name} must be {'>= 0' if name in _NON_NEGATIVE else '> 0'}")
        values[name] = float(value)
    return ScannerLimits(**values)


def load_profile(profile_id: str = "generic", directory: Path | str | None = None) -> ScannerProfile:
    """Read and validate ``<directory>/<profile_id>.json``.

    ``directory`` defaults to the profiles shipped in this repository.
    """
    if not _ID_PATTERN.match(profile_id):
        raise ScannerProfileError(f'scanner profile id "{profile_id}" must match [a-z0-9][a-z0-9_-]*')
    path = Path(directory if directory is not None else BUNDLED_PROFILE_DIRECTORY) / f"{profile_id}.json"
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ScannerProfileError(f"{path}: no such scanner profile") from error
    except json.JSONDecodeError as error:
        raise ScannerProfileError(f"{path}: invalid JSON: {error}") from error
    if not isinstance(raw, dict):
        raise ScannerProfileError(f"{path}: expected a JSON object")
    unknown = sorted(set(raw) - {"id", "title", "description", "limits"})
    if unknown:
        raise ScannerProfileError(f"{path}: unknown field(s) {', '.join(unknown)}")
    for key in ("id", "title"):
        if not isinstance(raw.get(key), str):
            raise ScannerProfileError(f"{path}: {key} must be a string")
    description = raw.get("description")
    if description is not None and not isinstance(description, str):
        raise ScannerProfileError(f"{path}: description must be a string")
    if raw["id"] != profile_id:
        raise ScannerProfileError(f'{path}: id "{raw["id"]}" does not match file name "{profile_id}"')
    return ScannerProfile(id=raw["id"], title=raw["title"], description=description, limits=_limits(raw.get("limits"), str(path)))


def to_opts(profile: ScannerProfile) -> pp.Opts:
    """Build the pypulseq system limits for a profile."""
    limits = profile.limits
    return pp.Opts(
        max_grad=limits.max_grad_mT_per_m,
        grad_unit="mT/m",
        max_slew=limits.max_slew_T_per_m_per_s,
        slew_unit="T/m/s",
        grad_raster_time=limits.grad_raster_time_s,
        rf_raster_time=limits.rf_raster_time_s,
        adc_raster_time=limits.adc_raster_time_s,
        block_duration_raster=limits.block_duration_raster_s,
        rf_dead_time=limits.rf_dead_time_s,
        rf_ringdown_time=limits.rf_ringdown_time_s,
        adc_dead_time=limits.adc_dead_time_s,
        B0=limits.b0_T,
    )

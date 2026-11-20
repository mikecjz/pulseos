"""Canonical JSON and content hashes used for fingerprints and revision identity."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

SIGNIFICANT_DIGITS = 12


def normalize(value: Any) -> Any:
    """Round floats to a fixed number of significant digits so hashes ignore float noise."""
    if isinstance(value, bool) or value is None or isinstance(value, (str, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError(f"non-finite number {value} cannot be serialized")
        if value == 0:
            return 0.0
        return float(f"{value:.{SIGNIFICANT_DIGITS}g}")
    if isinstance(value, dict):
        return {str(k): normalize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize(v) for v in value]
    if hasattr(value, "tolist"):
        return normalize(value.tolist())
    if hasattr(value, "item"):
        return normalize(value.item())
    raise TypeError(f"cannot serialize {type(value).__name__}")


def dumps(value: Any) -> str:
    """Compact, key-sorted JSON of the normalized value."""
    return json.dumps(normalize(value), sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    """sha256 over the canonical JSON of ``value``, as ``sha256:<hex>``."""
    return "sha256:" + hashlib.sha256(dumps(value).encode("utf-8")).hexdigest()


def digest_text(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()

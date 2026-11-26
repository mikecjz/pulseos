"""Build one sequence: JSON request on stdin, JSON result on stdout.

Request::

    {"recipe": {"path": "/abs/recipe.py"} | {"bundled": "gre2d"},   # or, to render a .seq file:
     "seqFile": {"path": "/abs/upload.seq", "name": "my.seq"},
     "params": {"TE": 0.004},            # strict overrides
     "baseParams": {"TR": 0.01},         # optional; inherited values, undeclared names ignored
     "profile": {"id": "generic", "directory": "/abs/profiles/scanner"},
     "seqPath": "/abs/out.seq",          # optional
     "confine": {"writable": "/abs/tmpdir"}}  # optional; see pulseos_seq.confine

``recipe`` and ``seqFile`` are exclusive. A ``seqFile`` request reads the file with pypulseq and
returns its model with roles derived from block contents (see ``pulseos_seq.adopt``); ``params``,
``baseParams`` and ``seqPath`` do not apply.

Result: ``{"ok": true, "model": {...}}`` or ``{"ok": false, "error": {kind, message, line, traceback}}``.
A recipe failure is a normal result (exit status 0); a malformed request exits with status 2.
With ``confine``, the recipe and profile are read first (a ``.seq`` file is parsed after confinement), then the process confines itself with
Landlock before any recipe code runs; if confinement is unavailable the build fails (``kind``
``sandbox``) instead of running unconfined.
"""

from __future__ import annotations

import io
import json
import sys
import warnings
from contextlib import redirect_stdout
from typing import Any

from .confine import ConfinementUnavailable, confine
from .recipe import RecipeError, build_sequence, bundled_recipe, load_recipe, read_sequence
from .scanner import ScannerProfileError, load_profile

PROTOCOL = "pulseos.build/1"


def handle(request: dict[str, Any]) -> dict[str, Any]:
    recipe_spec = request.get("recipe")
    seq_spec = request.get("seqFile")
    if seq_spec is not None:
        if recipe_spec is not None:
            raise ValueError('"recipe" and "seqFile" are exclusive')
        if not isinstance(seq_spec, dict) or not isinstance(seq_spec.get("path"), str):
            raise ValueError('"seqFile" must be {"path": ..., "name": ...}')
    elif not isinstance(recipe_spec, dict) or not (("path" in recipe_spec) ^ ("bundled" in recipe_spec)):
        raise ValueError('"recipe" must be {"path": ...} or {"bundled": ...}')
    profile_spec = request.get("profile") or {}
    try:
        profile = load_profile(profile_spec.get("id", "generic"), profile_spec.get("directory"))
    except ScannerProfileError as error:
        return {"ok": False, "error": {"kind": "profile", "message": str(error), "line": None, "traceback": None}}
    try:
        if seq_spec is not None:
            return _read(request, seq_spec, profile)
        if "bundled" in recipe_spec:
            source, filename = bundled_recipe(recipe_spec["bundled"])
        else:
            filename = str(recipe_spec["path"])
            with open(filename, encoding="utf-8") as handle_file:
                source = handle_file.read()
        abi, failure = _confine(request)
        if failure is not None:
            return failure
        recipe = load_recipe(source, filename)
        captured = io.StringIO()
        with warnings.catch_warnings(record=True) as caught, redirect_stdout(captured):
            warnings.simplefilter("always")
            model = build_sequence(recipe, profile, request.get("params"), request.get("seqPath"),
                                   request.get("baseParams"))
        model["warnings"] = sorted({str(w.message) for w in caught})
        model["confinement"] = {"landlockAbi": abi} if request.get("confine") is not None else None
        model["log"] = captured.getvalue()[-20000:]
        return {"ok": True, "model": model}
    except RecipeError as error:
        return {"ok": False, "error": error.to_json()}
    except OSError as error:
        return {"ok": False, "error": {"kind": "io", "message": str(error), "line": None, "traceback": None}}


def _confine(request: dict[str, Any]) -> tuple[int | None, dict[str, Any] | None]:
    """Apply the requested confinement: ``(abi, None)``, or ``(None, failure result)``."""
    confinement = request.get("confine")
    if confinement is None:
        return None, None
    try:
        return confine(str(confinement["writable"])), None
    except (ConfinementUnavailable, KeyError, TypeError, OSError) as error:
        return None, {"ok": False, "error": {"kind": "sandbox", "message": f"cannot confine the build: {error}",
                                             "line": None, "traceback": None}}


def _read(request: dict[str, Any], seq_spec: dict[str, Any], profile: Any) -> dict[str, Any]:
    abi, failure = _confine(request)
    if failure is not None:
        return failure
    path = str(seq_spec["path"])
    name = str(seq_spec.get("name") or path.rsplit("/", 1)[-1])
    captured = io.StringIO()
    with warnings.catch_warnings(record=True) as caught, redirect_stdout(captured):
        warnings.simplefilter("always")
        model = read_sequence(path, name, profile)
    model["warnings"] = sorted({str(w.message) for w in caught})
    model["confinement"] = {"landlockAbi": abi} if request.get("confine") is not None else None
    model["log"] = captured.getvalue()[-20000:]
    return {"ok": True, "model": model}


def main() -> int:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise ValueError("request must be a JSON object")
        result = handle(request)
    except (ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"ok": False, "error": {"kind": "protocol", "message": str(error)}}))
        return 2
    result["protocol"] = PROTOCOL
    sys.stdout.write(json.dumps(result, allow_nan=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

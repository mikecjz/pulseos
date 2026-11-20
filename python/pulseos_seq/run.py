"""Build one sequence: JSON request on stdin, JSON result on stdout.

Request::

    {"recipe": {"path": "/abs/recipe.py"} | {"bundled": "gre2d"},
     "params": {"TE": 0.004},
     "profile": {"id": "generic", "directory": "/abs/profiles/scanner"},
     "seqPath": "/abs/out.seq"}          # optional

Result: ``{"ok": true, "model": {...}}`` or ``{"ok": false, "error": {kind, message, line, traceback}}``.
A recipe failure is a normal result (exit status 0); a malformed request exits with status 2.
"""

from __future__ import annotations

import io
import json
import sys
import warnings
from contextlib import redirect_stdout
from typing import Any

from .recipe import RecipeError, build_sequence, bundled_recipe, load_recipe
from .scanner import ScannerProfileError, load_profile

PROTOCOL = "pulseos.build/1"


def handle(request: dict[str, Any]) -> dict[str, Any]:
    recipe_spec = request.get("recipe")
    if not isinstance(recipe_spec, dict) or not (("path" in recipe_spec) ^ ("bundled" in recipe_spec)):
        raise ValueError('"recipe" must be {"path": ...} or {"bundled": ...}')
    profile_spec = request.get("profile") or {}
    try:
        profile = load_profile(profile_spec.get("id", "generic"), profile_spec.get("directory"))
    except ScannerProfileError as error:
        return {"ok": False, "error": {"kind": "profile", "message": str(error), "line": None, "traceback": None}}
    try:
        if "bundled" in recipe_spec:
            source, filename = bundled_recipe(recipe_spec["bundled"])
        else:
            filename = str(recipe_spec["path"])
            with open(filename, encoding="utf-8") as handle_file:
                source = handle_file.read()
        recipe = load_recipe(source, filename)
        captured = io.StringIO()
        with warnings.catch_warnings(record=True) as caught, redirect_stdout(captured):
            warnings.simplefilter("always")
            model = build_sequence(recipe, profile, request.get("params"), request.get("seqPath"))
        model["warnings"] = sorted({str(w.message) for w in caught})
        model["log"] = captured.getvalue()[-20000:]
        return {"ok": True, "model": model}
    except RecipeError as error:
        return {"ok": False, "error": error.to_json()}
    except OSError as error:
        return {"ok": False, "error": {"kind": "io", "message": str(error), "line": None, "traceback": None}}


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

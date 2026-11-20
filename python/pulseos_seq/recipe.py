"""Load and build a recipe from source.

A recipe is a Python file that defines::

    SEQUENCE = "gre2d"                      # sequence name, the ID prefix
    PARAMS = {"TE": param(4.2e-3, "s", "Echo time"), ...}
    def build(b: SeqBuilder, p: Params) -> None: ...

Recipe source may be written by a model, so it is checked before it runs: imports are limited to
an allowlist, dunder attributes and a set of escape-hatch builtins are rejected, and it runs with a
reduced builtins table. This check is defence in depth only; the process sandbox applied by the
DSH sequence service is the security boundary.
"""

from __future__ import annotations

import ast
import builtins
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .builder import BuildError, Param, SeqBuilder, resolve_params
from .canonical import digest_text
from .ids import check_name, ElementIdError
from .model import build_model
from .scanner import ScannerProfile, to_opts

ALLOWED_IMPORTS = frozenset({"pulseos_seq", "pypulseq", "numpy", "math"})
FORBIDDEN_NAMES = frozenset({
    "__import__", "eval", "exec", "compile", "open", "input", "breakpoint", "globals", "locals",
    "vars", "getattr", "setattr", "delattr", "memoryview", "help", "exit", "quit",
})
BUNDLED_RECIPE_DIRECTORY = Path(__file__).resolve().parent / "recipes"


class RecipeError(Exception):
    """The recipe failed a check, failed to run, or produced an invalid sequence."""

    def __init__(self, kind: str, message: str, line: int | None = None, trace: str | None = None):
        super().__init__(message)
        self.kind = kind  # check | params | build | runtime
        self.line = line
        self.trace = trace

    def to_json(self) -> dict[str, Any]:
        return {"kind": self.kind, "message": str(self), "line": self.line, "traceback": self.trace}


def check_source(source: str, filename: str) -> ast.Module:
    """Parse the recipe and reject disallowed imports, names and attributes."""
    try:
        tree = ast.parse(source, filename=filename)
    except SyntaxError as error:
        raise RecipeError("check", f"syntax error: {error.msg}", error.lineno) from error
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] not in ALLOWED_IMPORTS:
                    raise RecipeError("check", f'import of "{alias.name}" is not allowed; allowed: '
                                      f"{', '.join(sorted(ALLOWED_IMPORTS))}", node.lineno)
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or "").split(".")[0] not in ALLOWED_IMPORTS:
                raise RecipeError("check", f'import from "{"." * node.level}{node.module or ""}" is not allowed; '
                                  f"allowed: {', '.join(sorted(ALLOWED_IMPORTS))}", node.lineno)
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise RecipeError("check", f'attribute "{node.attr}" is not allowed', node.lineno)
        elif isinstance(node, ast.Name) and (node.id in FORBIDDEN_NAMES or node.id.startswith("__")):
            raise RecipeError("check", f'name "{node.id}" is not allowed', node.lineno)
    return tree


def _guarded_import(name: str, globals: Any = None, locals: Any = None, fromlist: Any = (), level: int = 0) -> Any:
    if level or name.split(".")[0] not in ALLOWED_IMPORTS:
        raise ImportError(f'import of "{name}" is not allowed')
    return builtins.__import__(name, globals, locals, fromlist, level)


def _safe_builtins() -> dict[str, Any]:
    table = {k: v for k, v in vars(builtins).items() if k not in FORBIDDEN_NAMES and not k.startswith("__")}
    table["__import__"] = _guarded_import
    table["__build_class__"] = builtins.__build_class__
    return table


@dataclass
class Recipe:
    sequence: str
    params: dict[str, Param]
    build: Any
    source: str
    filename: str

    @property
    def hash(self) -> str:
        return digest_text(self.source)


def _recipe_line(trace: traceback.StackSummary, filename: str) -> int | None:
    lines = [frame.lineno for frame in trace if frame.filename == filename]
    return lines[-1] if lines else None


def load_recipe(source: str, filename: str) -> Recipe:
    """Check and execute the recipe module body, then validate its SEQUENCE/PARAMS/build."""
    tree = check_source(source, filename)
    namespace: dict[str, Any] = {"__builtins__": _safe_builtins(), "__name__": "pulseos_recipe"}
    try:
        exec(compile(tree, filename, "exec"), namespace)  # noqa: S102 - checked recipe source
    except Exception as error:
        tb = traceback.extract_tb(error.__traceback__)
        raise RecipeError("runtime", f"{type(error).__name__}: {error}", _recipe_line(tb, filename),
                          traceback.format_exc()) from error
    sequence = namespace.get("SEQUENCE")
    params = namespace.get("PARAMS")
    build = namespace.get("build")
    try:
        check_name("sequence", sequence)
    except ElementIdError as error:
        raise RecipeError("check", f"SEQUENCE: {error}") from error
    if not isinstance(params, dict) or not all(isinstance(v, Param) for v in params.values()):
        raise RecipeError("check", "PARAMS must be a dict of name -> param(...)")
    if not callable(build):
        raise RecipeError("check", "the recipe must define build(b, p)")
    return Recipe(sequence, params, build, source, filename)


def build_sequence(recipe: Recipe, profile: ScannerProfile, params: dict[str, Any] | None = None,
                   seq_path: str | Path | None = None) -> dict[str, Any]:
    """Run the recipe and return the sequence model; optionally write the ``.seq`` file."""
    try:
        resolved = resolve_params(recipe.params, params)
    except (BuildError, ElementIdError) as error:
        raise RecipeError("params", str(error)) from error
    b = SeqBuilder(recipe.sequence, to_opts(profile), resolved, recipe.filename)
    try:
        recipe.build(b, resolved)
    except BuildError as error:
        raise RecipeError("build", str(error), error.line, traceback.format_exc()) from error
    except ElementIdError as error:
        tb = traceback.extract_tb(error.__traceback__)
        raise RecipeError("build", str(error), _recipe_line(tb, recipe.filename), traceback.format_exc()) from error
    except Exception as error:
        tb = traceback.extract_tb(error.__traceback__)
        raise RecipeError("runtime", f"{type(error).__name__}: {error}", _recipe_line(tb, recipe.filename),
                          traceback.format_exc()) from error
    if not b.records.blocks:
        raise RecipeError("build", "build() added no blocks")
    b.seq.set_definition("Name", recipe.sequence)
    profile_json = {"id": profile.id, "title": profile.title, "limits": vars(profile.limits)}
    model = build_model(seq_name=recipe.sequence, seq=b.seq, records=b.records, declared=recipe.params,
                        params=resolved, profile=profile_json, recipe_hash=recipe.hash,
                        recipe_file=Path(recipe.filename).name)
    if seq_path is not None:
        b.seq.write(str(seq_path))
    return model


def bundled_recipe(name: str) -> tuple[str, str]:
    """Return ``(source, filename)`` of a recipe shipped with this package."""
    check_name("recipe", name)
    path = BUNDLED_RECIPE_DIRECTORY / f"{name}.py"
    if not path.is_file():
        raise RecipeError("check", f'no bundled recipe "{name}"')
    return path.read_text(encoding="utf-8"), str(path)

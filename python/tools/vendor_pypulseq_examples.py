"""Regenerate the pypulseq example templates in ``pulseos_seq/recipes`` from a pypulseq checkout.

Usage (from the repository root)::

    git clone --depth 1 --branch v1.5.0.post1 https://github.com/imr-framework/pypulseq.git /tmp/pypulseq
    uv run --project python python python/tools/vendor_pypulseq_examples.py /tmp/pypulseq

Each example script becomes a bundled recipe ``pypulseq_<name>.py``: the example's code with
plotting, the test report and ``.seq`` writing removed, standard-library imports that recipes may
not use replaced by their ``pulseos_seq`` re-exports, and a PulseOS recipe interface appended that
adopts the example's sequence (``b.adopt(main())``). ``templates.json`` lists every template the
viewer offers, the native ``gre2d`` recipe first.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

PYPULSEQ_VERSION = "1.5.0.post1"
RECIPES = Path(__file__).resolve().parents[1] / "pulseos_seq" / "recipes"

# (example script, template name, SEQUENCE, title, description)
EXAMPLES = [
    ("write_gre.py", "pypulseq_gre", "gre", "2D gradient echo", "Cartesian spoiled gradient echo (FLASH) with RF spoiling, 64 × 64."),
    ("write_radial_gre.py", "pypulseq_radial_gre", "radial_gre", "2D radial gradient echo", "Radial spoiled gradient echo with uniformly spaced spokes."),
    ("write_ute.py", "pypulseq_ute", "ute", "2D radial UTE", "Ultrashort echo time with half-pulse excitation and radial centre-out readouts."),
    ("write_epi.py", "pypulseq_epi", "epi", "2D echo-planar imaging", "Single-shot gradient-echo EPI, multi-slice."),
    ("write_epi_se.py", "pypulseq_epi_se", "epi_se", "2D spin-echo EPI", "Single-shot spin-echo EPI."),
    ("write_epi_se_rs.py", "pypulseq_epi_se_rs", "epi_se_rs", "Spin-echo EPI, ramp sampling", "Experimental spin-echo EPI with split blips overlapping the readout and ramp sampling."),
    ("write_tse.py", "pypulseq_tse", "tse", "2D turbo spin echo", "Multi-slice turbo spin echo (fast spin echo)."),
    ("write_haste.py", "pypulseq_haste", "haste", "HASTE", "Single-shot half-Fourier turbo spin echo."),
    ("write_mprage.py", "pypulseq_mprage", "mprage", "3D MPRAGE", "Magnetisation-prepared rapid gradient echo, 3D. Large: about 6000 blocks."),
]

NATIVE = {"name": "gre2d", "title": "2D gradient echo (PulseOS)", "origin": "pulseos",
          "description": "PulseOS's own spoiled GRE recipe with named roles and parameters (FOV, matrix, TE, TR, flip angle, ...)."}

IMPORT_REWRITES = {
    "import warnings": "from pulseos_seq import warn",
    "from types import SimpleNamespace": "from pulseos_seq import SimpleNamespace",
    "from copy import copy": "from pulseos_seq import copy",
    "from matplotlib import pyplot as plt": None,
}
DROPPED_FLAGS = {"plot", "write_seq", "paper_plot"}
DROPPED_CALLS = {"test_report", "calculate_kspace"}


def _names(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)}


def _call_attr(node: ast.AST) -> str | None:
    value = node.value if isinstance(node, (ast.Expr, ast.Assign)) else None
    if isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute):
        return value.func.attr
    return None


def adapt(source: str, script: str, sequence: str, title: str) -> str:
    """Return the template recipe source for one example script."""
    tree = ast.parse(source)
    drop: list[tuple[int, int]] = []
    for node in tree.body:
        if isinstance(node, ast.If) and "__name__" in _names(node.test):
            drop.append((node.lineno, node.end_lineno))
    main = next((n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main"), None)
    if main is None:
        raise SystemExit(f"{script}: no main() function")
    dropped_targets: set[str] = set()
    for node in main.body:
        if isinstance(node, ast.If) and _names(node.test) & DROPPED_FLAGS:
            drop.append((node.lineno, node.end_lineno))
        elif _call_attr(node) in DROPPED_CALLS:
            drop.append((node.lineno, node.end_lineno))
            if isinstance(node, ast.Assign):
                dropped_targets |= {t.id for t in node.targets if isinstance(t, ast.Name)}
        elif isinstance(node, ast.Expr) and dropped_targets & _names(node) and _names(node) <= {"print"} | dropped_targets:
            drop.append((node.lineno, node.end_lineno))  # print(rep) after a dropped rep = seq.test_report()
    lines = source.splitlines()
    keep = [True] * len(lines)
    for start, end in drop:
        for i in range(start - 1, end):
            keep[i] = False
        # Comments and blank lines right above a dropped statement belong to it (section headers).
        i = start - 2
        while i >= 0 and (not lines[i].strip() or lines[i].strip().startswith("#")):
            keep[i] = False
            i -= 1
    out: list[str] = []
    for line, kept in zip(lines, keep):
        if not kept:
            continue
        stripped = line.strip()
        if stripped in IMPORT_REWRITES:
            replacement = IMPORT_REWRITES[stripped]
            if replacement is None:
                continue
            line = line.replace(stripped, replacement)
        out.append(line.replace("warnings.warn(", "warn("))
    body = "\n".join(out).rstrip() + "\n"
    while "\n\n\n\n" in body:
        body = body.replace("\n\n\n\n", "\n\n\n")
    header = (
        f"# PulseOS template: {title}.\n"
        f"# Vendored from pypulseq v{PYPULSEQ_VERSION}, examples/scripts/{script}\n"
        "# (MIT License, Copyright (c) 2019-2025 PyPulseq Contributors; see LICENSE-pypulseq).\n"
        "# Regenerate with python/tools/vendor_pypulseq_examples.py. Changes from the example: plotting,\n"
        "# the test report and .seq writing are removed, and the PulseOS recipe interface is appended.\n\n"
    )
    footer = (
        "\n\n# -- PulseOS recipe interface ------------------------------------------------------------------\n"
        "# main() builds the complete pypulseq Sequence with the example's own system limits. PulseOS adopts\n"
        "# it as is and derives element roles from block contents: IDs look like\n"
        f"# {sequence}:excitation.rf@rep=0. Edit the values in main() to change the sequence.\n"
        f'SEQUENCE = "{sequence}"\n'
        "PARAMS = {}\n\n\n"
        "def build(b, p):\n"
        "    b.adopt(main())\n"
    )
    return header + body + footer


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    scripts = Path(argv[1]) / "examples" / "scripts"
    catalogue = [NATIVE]
    for script, name, sequence, title, description in EXAMPLES:
        source = (scripts / script).read_text(encoding="utf-8")
        (RECIPES / f"{name}.py").write_text(adapt(source, script, sequence, title), encoding="utf-8")
        catalogue.append({"name": name, "title": title, "origin": f"pypulseq {PYPULSEQ_VERSION} examples/scripts/{script}",
                          "description": description})
    (RECIPES / "templates.json").write_text(json.dumps(catalogue, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (RECIPES / "LICENSE-pypulseq").write_text((Path(argv[1]) / "LICENSE").read_text(encoding="utf-8"), encoding="utf-8")
    print(f"wrote {len(EXAMPLES)} templates to {RECIPES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

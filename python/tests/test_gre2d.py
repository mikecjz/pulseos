"""M1 acceptance: stable IDs, explicit 'gone', valid .seq, source spans, renames."""

import json
import math
import subprocess
import sys
from pathlib import Path

import pypulseq as pp
import pytest

from pulseos_seq.recipe import RecipeError, load_recipe
from pulseos_seq.resolve import resolve, resolve_between, role_diff

ROLES = ["excitation", "prephase", "te_fill", "readout", "spoil"]


def ids(model):
    return {b["id"] for b in model["blocks"]} | {e["id"] for e in model["events"]}


def role_ids(model):
    return {r["id"] for r in model["roles"]} | {e["id"] for r in model["roles"] for e in r["events"]}


def test_default_build_matches_parameters(build):
    model = build()
    assert [r["role"] for r in model["roles"]] == ROLES
    assert model["loops"] == [{"name": "slice", "size": 1}, {"name": "line", "size": 64}]
    assert len(model["blocks"]) == 5 * 64
    assert model["duration"] == pytest.approx(64 * 10e-3)
    assert model["timing"] == {"ok": True, "errors": []}
    te = next(m for m in model["markers"] if m["name"] == "TE")
    assert te["id"] == "gre2d:param.TE"
    assert te["t"] - te["start"] == pytest.approx(4.2e-3, abs=1e-9)
    rf = resolve(model, "gre2d:excitation.rf@slice=0,line=0")["element"]
    assert rf["flipAngle"] == pytest.approx(15.0, rel=1e-6)
    assert rf["duration"] == pytest.approx(1e-3)
    adc = resolve(model, "gre2d:readout.adc@slice=0,line=0")["element"]
    assert adc["numSamples"] == 64


def test_ids_are_stable_across_parameter_changes(build):
    base = build()
    for change in ({"TE": 5e-3}, {"TR": 12e-3}, {"flip_angle": 30.0}, {"FOV": 200e-3}):
        changed = build(change)
        assert ids(changed) == ids(base), change
        assert role_ids(changed) == role_ids(base), change


def test_fingerprints_track_content_not_position(build):
    base, longer_te, bigger_flip = build(), build({"TE": 5e-3}), build({"flip_angle": 30.0})
    # A longer TE only lengthens the TE fill; every RF pulse keeps its content.
    assert resolve_between(base, longer_te, "gre2d:excitation.rf")["status"] == "same"
    assert resolve_between(base, longer_te, "gre2d:te_fill")["status"] == "changed"
    assert resolve_between(base, longer_te, "gre2d:readout.adc@slice=0,line=10")["status"] == "same"
    # A flip-angle change changes the RF pulse and nothing in the readout.
    assert resolve_between(base, bigger_flip, "gre2d:excitation.rf")["status"] == "changed"
    assert resolve_between(base, bigger_flip, "gre2d:readout")["status"] == "same"
    assert resolve_between(base, bigger_flip, "gre2d:param.flip_angle")["status"] == "changed"
    assert resolve_between(base, bigger_flip, "gre2d:param.TE")["status"] == "same"


def test_builds_are_deterministic(gre2d_source):
    from pulseos_seq.recipe import build_sequence
    from pulseos_seq.scanner import load_profile

    recipe = load_recipe(*gre2d_source)
    a = build_sequence(recipe, load_profile())
    b = build_sequence(recipe, load_profile())
    assert [r["fingerprint"] for r in a["roles"]] == [r["fingerprint"] for r in b["roles"]]


def test_removed_instances_resolve_as_gone(build):
    base, smaller = build(), build({"Ny": 32})
    assert resolve(base, "gre2d:readout.adc@slice=0,line=40")["status"] == "ok"
    gone = resolve_between(base, smaller, "gre2d:readout.adc@slice=0,line=40")
    assert gone["status"] == "gone"
    assert "element" not in gone
    # Instances that still exist keep resolving; the role-level ID always does.
    assert resolve_between(base, smaller, "gre2d:readout.adc@slice=0,line=5")["status"] in ("same", "changed")
    assert resolve(smaller, "gre2d:readout.adc")["status"] == "ok"


@pytest.mark.parametrize("element_id", [
    "gre2d:nonexistent", "gre2d:readout.rf", "gre2d:readout@slice=0,line=999",
    "gre2d:readout@line=0", "gre2d:param.nope", "other:readout",
])
def test_unknown_ids_never_resolve_to_another_element(build, element_id):
    assert resolve(build(), element_id)["status"] == "gone"


def test_seq_file_passes_pypulseq_timing_check(build, tmp_path):
    path = tmp_path / "gre2d.seq"
    build(seq_path=str(path))
    seq = pp.Sequence()
    seq.read(str(path))
    ok, errors = seq.check_timing()
    assert ok, errors
    assert len(seq.block_events) == 5 * 64
    assert seq.get_definition("Name") == "gre2d"


def test_source_spans_point_at_block_calls(build, gre2d_source):
    lines = gre2d_source[0].splitlines()
    for role in build()["roles"]:
        span = role["sourceSpan"]
        text = "\n".join(lines[span["startLine"] - 1: span["endLine"]])
        assert f'b.block("{role["role"]}"' in text


def test_timing_errors_are_mapped_to_element_ids(build, gre2d_source):
    # A readout duration off the ADC/gradient raster produces timing errors on the readout.
    source = gre2d_source[0].replace(
        'adc = pp.make_adc(num_samples=p.Nx, duration=gx.flat_time, delay=gx.rise_time, system=system)',
        'adc = pp.make_adc(num_samples=p.Nx, duration=gx.flat_time, delay=gx.rise_time + 3e-7, system=system)')
    model = build(source=source)
    assert model["timing"]["ok"] is False
    first = model["timing"]["errors"][0]
    assert first["ids"][0].startswith("gre2d:readout.adc@")
    assert first["message"]


def test_declared_rename_keeps_references_resolving(build, gre2d_source):
    renamed_source = gre2d_source[0].replace('b.block("excitation", rf=rf, gz=gz)',
                                             'b.block("rf_excite", formerly="excitation", rf=rf, gz=gz)')
    base, renamed = build(), build(source=renamed_source)
    result = resolve_between(base, renamed, "gre2d:excitation.rf@slice=0,line=3")
    assert result["status"] == "same"
    assert result["id"] == "gre2d:rf_excite.rf@slice=0,line=3"
    assert result["renamedFrom"] == "gre2d:excitation.rf@slice=0,line=3"
    assert role_diff(base, renamed)["renamed"] == ["excitation->rf_excite"]


def test_undeclared_rename_is_removed_plus_added(build, gre2d_source):
    renamed_source = gre2d_source[0].replace('b.block("excitation", rf=rf, gz=gz)', 'b.block("rf_excite", rf=rf, gz=gz)')
    base, renamed = build(), build(source=renamed_source)
    assert resolve_between(base, renamed, "gre2d:excitation.rf")["status"] == "gone"
    diff = role_diff(base, renamed)
    assert diff["added"] == ["rf_excite"] and diff["removed"] == ["excitation"]


def test_parameter_validation(build):
    with pytest.raises(RecipeError, match="unknown parameter"):
        build({"TEE": 1})
    with pytest.raises(RecipeError, match="above its maximum"):
        build({"flip_angle": 120.0})
    with pytest.raises(RecipeError, match="integer"):
        build({"Ny": 10.5})


def test_recipe_errors_report_the_recipe_line(build, gre2d_source):
    with pytest.raises(RecipeError) as caught:
        build({"TE": 1e-3})
    assert caught.value.kind == "runtime"
    assert "too short" in str(caught.value)
    line = gre2d_source[0].splitlines()[caught.value.line - 1]
    assert "raise ValueError" in line


@pytest.mark.parametrize(("snippet", "message"), [
    ("import os", 'import of "os"'),
    ("import subprocess as sp", 'import of "subprocess"'),
    ("from os import path", 'import from "os"'),
    ("x = open('/etc/passwd')", 'name "open"'),
    ("x = ().__class__", 'attribute "__class__"'),
    ("x = eval('1')", 'name "eval"'),
    ("x = __builtins__", 'name "__builtins__"'),
])
def test_guard_rejects_unsafe_source(gre2d_source, snippet, message):
    with pytest.raises(RecipeError, match=message) as caught:
        load_recipe(snippet + "\n" + gre2d_source[0], "recipe.py")
    assert caught.value.kind == "check" and caught.value.line == 1


def test_role_rules(build, gre2d_source):
    twice = gre2d_source[0].replace('b.block("te_fill", delay=pp.make_delay(te_fill))',
                                    'for _ in range(2): b.block("te_fill", delay=pp.make_delay(te_fill))')
    with pytest.raises(RecipeError, match="added twice"):
        build(source=twice)
    two_sites = gre2d_source[0].replace('b.block("te_fill", delay=pp.make_delay(te_fill))',
                                        'b.block("readout", delay=pp.make_delay(te_fill))')
    with pytest.raises(RecipeError, match="two places"):
        build(source=two_sites)


def test_cli_round_trip(tmp_path):
    request = {"recipe": {"bundled": "gre2d"}, "params": {"Ny": 16}, "seqPath": str(tmp_path / "out.seq")}
    done = subprocess.run([sys.executable, "-m", "pulseos_seq.run"], input=json.dumps(request),
                          capture_output=True, text=True, check=True)
    result = json.loads(done.stdout)
    assert result["ok"] and result["protocol"] == "pulseos.build/1"
    assert len(result["model"]["blocks"]) == 5 * 16
    assert (tmp_path / "out.seq").is_file()
    failing = subprocess.run([sys.executable, "-m", "pulseos_seq.run"],
                             input=json.dumps({"recipe": {"bundled": "gre2d"}, "params": {"TR": 1e-2, "TE": 1e-3}}),
                             capture_output=True, text=True, check=True)
    error = json.loads(failing.stdout)["error"]
    assert error["kind"] == "runtime" and error["line"] > 0
    bad = subprocess.run([sys.executable, "-m", "pulseos_seq.run"], input="[]", capture_output=True, text=True)
    assert bad.returncode == 2


def test_base_params_are_inherited_leniently(gre2d_source):
    from pulseos_seq.recipe import build_sequence
    from pulseos_seq.scanner import load_profile

    recipe = load_recipe(*gre2d_source)
    model = build_sequence(recipe, load_profile(), {"Ny": 8}, None, {"TE": 5e-3, "removed_param": 1, "Ny": 16})
    assert model["params"]["TE"]["value"] == 5e-3
    assert model["params"]["Ny"]["value"] == 8  # overrides win over inherited values
    with pytest.raises(RecipeError, match="above its maximum"):
        build_sequence(recipe, load_profile(), None, None, {"flip_angle": 500.0})

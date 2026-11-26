"""Templates (pypulseq example recipes) and read-only rendering of .seq files."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from pulseos_seq.recipe import RecipeError, build_sequence, bundled_recipe, load_recipe, read_sequence
from pulseos_seq.resolve import resolve
from pulseos_seq.scanner import load_profile

RECIPES = Path(__file__).resolve().parents[1] / "pulseos_seq" / "recipes"
CATALOGUE = json.loads((RECIPES / "templates.json").read_text(encoding="utf-8"))
PROFILE = load_profile("generic")


def test_catalogue_lists_existing_recipes_native_first():
    assert CATALOGUE[0]["name"] == "gre2d" and CATALOGUE[0]["origin"] == "pulseos"
    names = [t["name"] for t in CATALOGUE]
    assert len(names) == len(set(names))
    for template in CATALOGUE:
        assert (RECIPES / f"{template['name']}.py").is_file()
        assert template["title"] and template["description"]
    assert {p.stem for p in RECIPES.glob("pypulseq_*.py")} == {n for n in names if n.startswith("pypulseq_")}


@pytest.mark.parametrize("name", [t["name"] for t in CATALOGUE])
def test_every_template_passes_the_recipe_check_and_builds_without_timing_errors(name):
    model = build_sequence(load_recipe(*bundled_recipe(name)), PROFILE)
    assert model["blocks"] and model["timing"]["ok"], model["timing"]["errors"][:3]


def test_epi_template_roles_follow_block_contents():
    model = build_sequence(load_recipe(*bundled_recipe("pypulseq_epi")), PROFILE)
    assert model["seq"] == "epi"
    assert model["params"] == {}
    roles = {r["role"]: r["instances"] for r in model["roles"]}
    assert roles == {"excitation": 3, "grad_xyz": 3, "readout": 192, "grad_y": 192}
    # rep counts excitations (slices); n counts readouts within one echo train and is an inner loop.
    assert model["loops"] == [{"name": "rep", "size": 3}, {"name": "n", "size": 64, "inner": True}]
    assert resolve(model, "epi:excitation.rf@rep=2")["status"] == "ok"
    adc = resolve(model, "epi:readout.adc@rep=1,n=63")["element"]
    assert adc["channel"] == "adc"
    # Recipe source spans do not exist for adopted blocks.
    assert all(r["sourceSpan"] is None for r in model["roles"])


def test_adopt_is_the_only_way_blocks_are_added():
    source = '''
import pypulseq as pp
SEQUENCE = "mixed"
PARAMS = {}
def build(b, p):
    b.block("wait", delay=pp.make_delay(1e-3))
    b.adopt(pp.Sequence())
'''
    with pytest.raises(RecipeError, match="adopt"):
        build_sequence(load_recipe(source, "recipe.py"), PROFILE)


@pytest.fixture(scope="module")
def gre_file(tmp_path_factory):
    path = tmp_path_factory.mktemp("seq") / "gre 2d.seq"
    build_sequence(load_recipe(*bundled_recipe("gre2d")), PROFILE, {"Ny": 8}, path)
    return path


def test_read_sequence_renders_a_seq_file_with_derived_roles(gre_file):
    model = read_sequence(gre_file, "gre 2d.seq", PROFILE)
    assert model["seq"] == "gre2d"  # the file's Name definition
    assert model["recipe"]["file"] == "gre 2d.seq"
    assert model["params"] == {} and model["markers"] == []
    assert [r["role"] for r in model["roles"]] == ["excitation", "grad_xyz", "delay", "readout", "grad_xyz_2"]
    assert model["loops"] == [{"name": "rep", "size": 8}]
    assert len(model["blocks"]) == 5 * 8
    assert model["timing"]["ok"]
    rf = resolve(model, "gre2d:excitation.rf@rep=0")["element"]
    assert rf["flipAngle"] == pytest.approx(15.0, rel=1e-3)


def test_read_sequence_names_a_file_without_a_name_definition_after_the_file(tmp_path, gre_file):
    text = "\n".join(line for line in gre_file.read_text().splitlines() if not line.startswith("Name "))
    path = tmp_path / "2-my scan.seq"
    path.write_text(text)
    assert read_sequence(path, path.name, PROFILE)["seq"] == "seq_2_my_scan"


def test_read_sequence_reports_an_unreadable_file(tmp_path):
    path = tmp_path / "broken.seq"
    path.write_text("[VERSION]\nmajor 1\nnot a sequence\n")
    with pytest.raises(RecipeError) as caught:
        read_sequence(path, "broken.seq", PROFILE)
    assert caught.value.kind == "read"


def test_runner_reads_a_seq_file(gre_file):
    request = {"seqFile": {"path": str(gre_file), "name": "scan.seq"}, "profile": {"id": "generic"}}
    result = subprocess.run([sys.executable, "-m", "pulseos_seq.run"], input=json.dumps(request), capture_output=True,
                            text=True, check=True)
    reply = json.loads(result.stdout)
    assert reply["ok"] and reply["model"]["recipe"]["file"] == "scan.seq"
    assert len(reply["model"]["blocks"]) == 40


def test_runner_rejects_recipe_and_seq_file_together(gre_file):
    request = {"seqFile": {"path": str(gre_file)}, "recipe": {"bundled": "gre2d"}}
    result = subprocess.run([sys.executable, "-m", "pulseos_seq.run"], input=json.dumps(request), capture_output=True, text=True)
    assert result.returncode == 2
    assert "exclusive" in json.loads(result.stdout)["error"]["message"]

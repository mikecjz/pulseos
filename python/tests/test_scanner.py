"""Scanner profiles load into pypulseq limits; invalid profiles are rejected."""

import json

import pypulseq as pp
import pytest

from pulseos_seq.scanner import BUNDLED_PROFILE_DIRECTORY, ScannerProfileError, load_profile, to_opts

GAMMA = 42.576e6  # Hz/T, pypulseq's default proton gyromagnetic ratio


def test_generic_profile_converts_to_pypulseq_limits():
    profile = load_profile("generic")
    opts = to_opts(profile)
    assert profile.limits.max_grad_mT_per_m == 40
    assert opts.max_grad == pytest.approx(40e-3 * GAMMA)
    assert opts.max_slew == pytest.approx(150 * GAMMA)
    assert opts.B0 == 3.0
    assert opts.rf_dead_time == pytest.approx(1e-4)


def test_generic_limits_build_a_valid_block():
    """A trapezoid at the gradient limit fits the generic profile and passes pypulseq's timing check."""
    system = to_opts(load_profile("generic"))
    seq = pp.Sequence(system=system)
    seq.add_block(pp.make_trapezoid(channel="x", area=1000, system=system))
    ok, errors = seq.check_timing()
    assert ok, errors


def _write(tmp_path, name, profile):
    (tmp_path / f"{name}.json").write_text(json.dumps(profile))
    return tmp_path


def _generic():
    return json.loads((BUNDLED_PROFILE_DIRECTORY / "generic.json").read_text())


@pytest.mark.parametrize(
    ("label", "mutate", "file_id", "load_id"),
    [
        ("missing file", None, None, "absent"),
        ("id mismatch", lambda p: p, "other", "other"),
        ("unknown top-level field", lambda p: {**p, "id": "x", "vendor": "acme"}, "x", "x"),
        ("unknown limit", lambda p: {**p, "id": "x", "limits": {**p["limits"], "max_grad": 40}}, "x", "x"),
        ("missing limit", lambda p: {**p, "id": "x", "limits": {k: v for k, v in p["limits"].items() if k != "max_slew_T_per_m_per_s"}}, "x", "x"),
        ("zero gradient limit", lambda p: {**p, "id": "x", "limits": {**p["limits"], "max_grad_mT_per_m": 0}}, "x", "x"),
        ("negative dead time", lambda p: {**p, "id": "x", "limits": {**p["limits"], "rf_dead_time_s": -1}}, "x", "x"),
        ("boolean limit", lambda p: {**p, "id": "x", "limits": {**p["limits"], "b0_T": True}}, "x", "x"),
        ("path separator in id", None, None, "../generic"),
    ],
)
def test_invalid_profiles_are_rejected(tmp_path, label, mutate, file_id, load_id):
    if mutate is not None:
        _write(tmp_path, file_id, mutate(_generic()))
    with pytest.raises(ScannerProfileError):
        load_profile(load_id, tmp_path)


def test_zero_dead_times_are_allowed(tmp_path):
    profile = _generic()
    profile = {**profile, "id": "ideal", "limits": {**profile["limits"], "rf_dead_time_s": 0, "rf_ringdown_time_s": 0, "adc_dead_time_s": 0}}
    _write(tmp_path, "ideal", profile)
    assert load_profile("ideal", tmp_path).limits.rf_dead_time_s == 0

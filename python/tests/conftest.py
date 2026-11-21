import warnings

import pytest

from pulseos_seq.recipe import build_sequence, bundled_recipe, load_recipe
from pulseos_seq.scanner import load_profile


@pytest.fixture(scope="session")
def gre2d_source():
    return bundled_recipe("gre2d")


@pytest.fixture(scope="session")
def build(gre2d_source):
    """Build gre2d (or a modified source) with parameter overrides; results are cached per input."""
    cache = {}
    profile = load_profile("generic")

    def _build(params=None, source=None, seq_path=None):
        src, filename = (source, "recipe.py") if source is not None else gre2d_source
        key = (src, tuple(sorted((params or {}).items())), seq_path)
        if key not in cache:
            with warnings.catch_warnings():
                warnings.simplefilter("error")
                cache[key] = build_sequence(load_recipe(src, filename), profile, params, seq_path)
        return cache[key]

    return _build

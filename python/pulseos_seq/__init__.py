"""pypulseq sequence backend for PulseOS.

Recipes import their API from here: ``from pulseos_seq import param``. ``copy``, ``SimpleNamespace``
and ``warn`` are re-exported for the pypulseq example templates, because recipes may not import the
standard-library modules that hold them.
"""

from copy import copy
from types import SimpleNamespace
from warnings import warn

from .builder import BuildError, Params, SeqBuilder, param

__all__ = ["BuildError", "Params", "SeqBuilder", "SimpleNamespace", "copy", "param", "warn"]

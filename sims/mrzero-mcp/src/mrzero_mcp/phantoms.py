"""Phantoms offered by the server.

- ``tubes``: a numeric phantom generated in code: six vials with distinct T1/T2 in air.
- ``brainweb-axial``: one axial slice of BrainWeb subject 04 at 3 T, prepared once by
  :func:`prepare_brainweb` (needs network) and stored as ``<phantom dir>/brainweb-axial.npz``.

Both are 2D (one voxel in z). Maps use SI units: T1/T2/T2' in s, D in 1e-3 mm^2/s, B0 in Hz.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

#: Tissue properties at 3 T, taken from MRzero's ``brainweb_data.json`` (field "3").
TUBES = [
    # (name, x [m], y [m], radius [m], T1 [s], T2 [s], PD)
    ("fat-like", -0.050, -0.045, 0.022, 0.37, 0.125, 1.0),
    ("wm-like", 0.000, -0.045, 0.022, 0.83, 0.075, 0.7),
    ("gm-like", 0.050, -0.045, 0.022, 1.56, 0.083, 0.8),
    ("long-T2", -0.050, 0.045, 0.022, 1.20, 0.300, 0.9),
    ("short-T2", 0.000, 0.045, 0.022, 1.00, 0.030, 0.9),
    ("csf-like", 0.050, 0.045, 0.022, 4.16, 1.650, 1.0),
]
TUBES_FOV = 0.2
TUBES_N = 128
SLICE_THICKNESS = 0.003

BRAINWEB_FILE = "brainweb-axial.npz"
BRAINWEB_SUBJECT = 4
BRAINWEB_SLICE = 220  # 0.5 mm voxels; z = 220 * 0.5 - 90.5 = 19.5 mm, through the lateral ventricles


@dataclass(frozen=True)
class PhantomMaps:
    """Parameter maps of one phantom, shape (nx, ny, 1)."""

    id: str
    title: str
    description: str
    fov: tuple[float, float, float]
    PD: np.ndarray
    T1: np.ndarray
    T2: np.ndarray
    T2dash: np.ndarray
    D: np.ndarray
    B0: np.ndarray
    B1: np.ndarray
    tissues: dict[str, np.ndarray]

    def content_hash(self) -> str:
        """``sha256:<hex>`` over the maps and geometry, so results can be cached by content."""
        digest = hashlib.sha256()
        digest.update(json.dumps({"id": self.id, "fov": self.fov}).encode())
        for array in (self.PD, self.T1, self.T2, self.T2dash, self.D, self.B0, self.B1):
            digest.update(np.ascontiguousarray(array, dtype=np.float32).tobytes())
        return f"sha256:{digest.hexdigest()}"

    def info(self) -> dict:
        nx, ny, nz = self.PD.shape
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "dims": [nx, ny, nz],
            "fov": list(self.fov),
            "tissues": sorted(self.tissues),
            "hash": self.content_hash(),
        }


def tubes() -> PhantomMaps:
    """Six vials with distinct relaxation times, for contrast checks."""
    n = TUBES_N
    axis = (np.arange(n) - n / 2 + 0.5) * (TUBES_FOV / n)
    x, y = np.meshgrid(axis, axis, indexing="ij")
    shape = (n, n, 1)
    PD, T1, T2 = (np.zeros(shape, np.float32) for _ in range(3))
    tissues: dict[str, np.ndarray] = {}
    for name, cx, cy, radius, t1, t2, pd in TUBES:
        mask = ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2)[..., None]
        PD[mask], T1[mask], T2[mask] = pd, t1, t2
        tissues[name] = mask.astype(np.float32)
    T1[PD == 0], T2[PD == 0] = 1.0, 0.1
    return PhantomMaps(
        id="tubes",
        title="Relaxation tubes",
        description="Numeric phantom: six vials (fat-, WM-, GM-, CSF-like, long and short T2) at 3 T, 200 mm FOV.",
        fov=(TUBES_FOV, TUBES_FOV, SLICE_THICKNESS),
        PD=PD, T1=T1, T2=T2,
        T2dash=np.full(shape, 0.1, np.float32) * (PD > 0),
        D=np.zeros(shape, np.float32),
        B0=np.zeros(shape, np.float32),
        B1=np.ones((1, *shape), np.float32),
        tissues=tissues,
    )


def prepare_brainweb(directory: Path, cache: Path | None = None) -> Path:
    """Download BrainWeb subject 04 and store one 1 mm axial slice as an ``.npz`` phantom.

    Raw segmentations come from the BrainWeb database (https://brainweb.bic.mni.mcgill.ca/);
    tissue properties and the download helper from MRzero-Core.
    """
    from MRzeroCore.phantom.brainweb import generate_B0_B1, load_tissue

    config = json.loads((Path(__import__("MRzeroCore").__file__).parent / "phantom/brainweb/brainweb_data.json").read_text())
    cache = cache or directory / "cache"
    cache.mkdir(parents=True, exist_ok=True)
    props = config["props"]["3"]
    density = config["density"]
    fractions = {}
    for tissue, aliases in config["download-aliases"].items():
        fraction = 0
        for alias in aliases:
            volume = load_tissue(BRAINWEB_SUBJECT, alias, cache)
            # 0.5 mm -> 1 mm in-plane (2x2 mean), 2 mm slab through the chosen slice.
            slab = volume[:, :, BRAINWEB_SLICE - 2:BRAINWEB_SLICE + 2].mean(axis=2)
            fraction = fraction + slab.reshape(181, 2, 217, 2).mean(axis=(1, 3))
        fractions[tissue] = np.clip(fraction, 0, 1)
    pd = sum(density[t] * fractions[t] for t in fractions)
    weights = {t: density[t] * fractions[t] / np.maximum(pd, 1e-9) for t in fractions}
    maps = {}
    for key, prop in (("T1_map", "T1"), ("T2_map", "T2"), ("T2dash_map", "T2'"), ("D_map", "ADC")):
        maps[key] = sum(weights[t] * props[t][prop] for t in fractions)
    # Pad x (181 mm) to the y extent (217 mm) so the FOV is square.
    pad = ((18, 18), (0, 0))
    out = {k: np.pad(v, pad)[..., None].astype(np.float32) for k, v in maps.items()}
    out["PD_map"] = np.pad(pd, pad)[..., None].astype(np.float32)
    mask = out["PD_map"] > 1e-3
    B0, B1 = generate_B0_B1(mask)
    out["B0_map"] = B0.astype(np.float32)
    out["B1_map"] = B1.astype(np.float32)
    for t in fractions:
        out[f"tissue_{t}"] = np.pad(fractions[t], pad)[..., None].astype(np.float32)
    out["FOV"] = np.array([0.217, 0.217, SLICE_THICKNESS], np.float32)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / BRAINWEB_FILE
    np.savez_compressed(path, **out)
    return path


def brainweb(directory: Path) -> PhantomMaps | None:
    """The prepared BrainWeb slice, or None when it has not been prepared."""
    path = directory / BRAINWEB_FILE
    if not path.exists():
        return None
    with np.load(path) as data:
        tissues = {k.removeprefix("tissue_"): data[k] for k in data.files if k.startswith("tissue_")}
        b1 = data["B1_map"]
        return PhantomMaps(
            id="brainweb-axial",
            title="BrainWeb brain, axial slice",
            description="BrainWeb subject 04, 1 mm axial slice through the lateral ventricles, 3 T tissue values, synthetic B0/B1 maps.",
            fov=tuple(float(v) for v in data["FOV"]),  # type: ignore[arg-type]
            PD=data["PD_map"], T1=data["T1_map"], T2=data["T2_map"], T2dash=data["T2dash_map"], D=data["D_map"],
            B0=data["B0_map"], B1=b1 if b1.ndim == 4 else b1[None],
            tissues=tissues,
        )


class PhantomLibrary:
    """Phantoms available to this server; loaded maps are cached."""

    def __init__(self, directory: Path):
        self.directory = directory
        self._cache: dict[str, PhantomMaps] = {}

    def all(self) -> list[PhantomMaps]:
        found = [self.get("tubes")]
        bw = self.get("brainweb-axial", missing_ok=True)
        if bw is not None:
            found.insert(0, bw)
        return found

    def get(self, phantom_id: str, missing_ok: bool = False) -> PhantomMaps | None:
        if phantom_id in self._cache:
            return self._cache[phantom_id]
        maps = tubes() if phantom_id == "tubes" else brainweb(self.directory) if phantom_id == "brainweb-axial" else None
        if maps is None:
            if missing_ok:
                return None
            raise KeyError(f'unknown phantom "{phantom_id}"; call list_phantoms')
        self._cache[phantom_id] = maps
        return maps

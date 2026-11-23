"""One simulation: Pulseq text + phantom -> ADC signal, Cartesian k-space and image.

Runs synchronously in a worker thread. ``progress(done, total)`` is called once per sequence
repetition and may raise :class:`Cancelled` to stop between repetitions.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
import torch

from .phantoms import PhantomMaps

MAX_RESOLUTION = 256


class Cancelled(Exception):
    """The caller cancelled the simulation."""


class SimulationError(Exception):
    """The inputs cannot be simulated; the message is shown to the user."""


@dataclass
class Settings:
    """Simulation settings; every field has a default."""

    resolution: int | None = None
    max_states: int = 200
    min_state_mag: float = 1e-4
    min_emitted: float = 0.01
    min_latent: float = 0.01
    noise: float = 0.0
    b0: bool = True
    b1: bool = True

    @classmethod
    def parse(cls, raw: dict | None) -> "Settings":
        raw = raw or {}
        known = {"resolution", "maxStates", "minStateMag", "minEmitted", "minLatent", "noise", "b0", "b1"}
        unknown = set(raw) - known
        if unknown:
            raise SimulationError(f"unknown settings: {', '.join(sorted(unknown))}")
        s = cls(
            resolution=raw.get("resolution"),
            max_states=int(raw.get("maxStates", 200)),
            min_state_mag=float(raw.get("minStateMag", 1e-4)),
            min_emitted=float(raw.get("minEmitted", 0.01)),
            min_latent=float(raw.get("minLatent", 0.01)),
            noise=float(raw.get("noise", 0.0)),
            b0=bool(raw.get("b0", True)),
            b1=bool(raw.get("b1", True)),
        )
        if s.resolution is not None and not (8 <= int(s.resolution) <= MAX_RESOLUTION):
            raise SimulationError(f"resolution must be between 8 and {MAX_RESOLUTION}")
        if not (1 <= s.max_states <= 10_000):
            raise SimulationError("maxStates must be between 1 and 10000")
        if not (0 <= s.noise <= 1):
            raise SimulationError("noise must be between 0 and 1 (fraction of the peak signal)")
        return s


@dataclass
class Result:
    arrays: dict[str, np.ndarray]
    stats: dict
    timing: dict[str, float]
    grid: dict
    warnings: list[str] = field(default_factory=list)


@contextmanager
def _progress_hook(progress: Callable[[int, int], None]):
    """Route MRzero's per-repetition tqdm updates to ``progress`` (the only checkpoint it offers)."""
    from MRzeroCore.simulation import main_pass

    class Hook:
        def __init__(self, total: int = 0, **_: object):
            self.total, self.n = total, 0

        def update(self, k: int = 1) -> None:
            self.n += k
            progress(self.n, self.total)

        def close(self) -> None:
            pass

    original = main_pass.tqdm
    main_pass.tqdm = Hook
    try:
        yield
    finally:
        main_pass.tqdm = original


def _grid(kspace: np.ndarray, samples_per_adc: int) -> dict:
    """Infer the Cartesian matrix and FOV from the ADC trajectory (1/m)."""
    kx, ky = kspace[:, 0], kspace[:, 1]
    n = len(kx)
    nx = samples_per_adc
    ny = n // nx
    dkx = float(np.median(np.abs(np.diff(kx[:nx])))) if nx > 1 else 0.0
    lines = np.unique(np.round(ky.reshape(ny, nx).mean(axis=1), 6))
    dky = float(np.median(np.diff(lines))) if len(lines) > 1 else 0.0
    if dkx <= 0 or dky <= 0:
        raise SimulationError("the sequence's ADC trajectory is not a 2D Cartesian grid; only Cartesian 2D sequences are supported yet")
    # Index from the smallest k so half-sample readout offsets stay on the grid.
    rx, ry = (kx - kx.min()) / dkx, (ky - ky.min()) / dky
    ix, iy = np.round(rx).astype(int), np.round(ry).astype(int)
    on_grid = bool((np.abs(rx - ix) < 0.05).all() and (np.abs(ry - iy) < 0.05).all())
    inside = ix.max() < nx and iy.max() < ny
    return {"nx": nx, "ny": ny, "fov": [1 / dkx, 1 / dky], "cartesian": bool(on_grid and inside), "ix": ix, "iy": iy}


def _tissue_means(phantom: PhantomMaps, image: np.ndarray, fov: list[float]) -> dict[str, float]:
    """Mean image magnitude inside each tissue (voxels at least 80% that tissue), nearest-neighbour mapped."""
    ny, nx = image.shape
    pnx, pny, _ = phantom.PD.shape
    xs = (np.arange(nx) - nx / 2 + 0.5) * fov[0] / nx
    ys = (np.arange(ny) - ny / 2 + 0.5) * fov[1] / ny
    ys = ys[::-1]  # image row 0 is +y
    jx = np.round(xs / (phantom.fov[0] / pnx) + pnx / 2 - 0.5).astype(int)
    jy = np.round(ys / (phantom.fov[1] / pny) + pny / 2 - 0.5).astype(int)
    vx, vy = (jx >= 0) & (jx < pnx), (jy >= 0) & (jy < pny)
    means = {}
    mag = np.abs(image)
    for name, mask in phantom.tissues.items():
        sampled = np.zeros((ny, nx), np.float32)
        sampled[np.ix_(vy, vx)] = mask[:, :, 0][np.ix_(jx[vx], jy[vy])].T
        pure = sampled >= 0.8
        if pure.sum() >= 2:
            means[name] = float(mag[pure].mean())
    return means


def simulate(seq_text: str, phantom: PhantomMaps, settings: Settings, device: str,
             progress: Callable[[int, int], None]) -> Result:
    import MRzeroCore as mr0

    timing: dict[str, float] = {}
    t = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="mrzero-") as scratch:
        path = Path(scratch) / "in.seq"
        path.write_text(seq_text)
        try:
            seq = mr0.Sequence.import_file(str(path))
        except Exception as error:  # noqa: BLE001 - parser errors are user input errors
            raise SimulationError(f"MRzero could not read the .seq file: {error}") from error
    timing["parseMs"] = (time.perf_counter() - t) * 1e3

    kspace = seq.get_kspace().cpu().numpy()
    adc_reps = [rep for rep in seq if int(rep.adc_usage.gt(0).sum()) > 0]
    if not adc_reps or len(kspace) == 0:
        raise SimulationError("the sequence has no ADC samples")
    per_adc = {int(rep.adc_usage.gt(0).sum()) for rep in adc_reps}
    if len(per_adc) != 1:
        raise SimulationError("ADC events have different sample counts; only Cartesian 2D sequences are supported yet")
    samples = per_adc.pop()
    grid = _grid(kspace, samples)
    nx, ny = grid["nx"], grid["ny"]

    t = time.perf_counter()
    res = settings.resolution or min(max(nx, ny), MAX_RESOLUTION)
    n = phantom.PD.shape[0]
    affine = torch.tensor([
        [phantom.fov[0] / n * 1000, 0, 0, -phantom.fov[0] * 500 + phantom.fov[0] / n * 500],
        [0, phantom.fov[1] / phantom.PD.shape[1] * 1000, 0, -phantom.fov[1] * 500 + phantom.fov[1] / phantom.PD.shape[1] * 500],
        [0, 0, phantom.fov[2] * 1000, 0],
    ], dtype=torch.float32)
    B0 = phantom.B0 if settings.b0 else np.zeros_like(phantom.B0)
    B1 = phantom.B1 if settings.b1 else np.ones_like(phantom.B1)
    obj = mr0.VoxelGridPhantom(phantom.PD, phantom.T1, phantom.T2, phantom.T2dash, phantom.D, B0, B1,
                               torch.ones(1, *phantom.PD.shape), affine)
    data = obj.interpolate(res, res, 1).build()
    if device.startswith("cuda"):
        # The server selected the device with torch.cuda.set_device at startup.
        data = data.cuda()
        seq = seq.cuda()
    timing["phantomMs"] = (time.perf_counter() - t) * 1e3

    t = time.perf_counter()
    graph = mr0.compute_graph(seq, data, settings.max_states, settings.min_state_mag)
    timing["graphMs"] = (time.perf_counter() - t) * 1e3

    t = time.perf_counter()
    with _progress_hook(progress):
        signal = mr0.execute_graph(graph, seq, data, settings.min_emitted, settings.min_latent, print_progress=True)
    if device.startswith("cuda"):
        torch.cuda.synchronize()
    timing["simulateMs"] = (time.perf_counter() - t) * 1e3

    t = time.perf_counter()
    signal = signal.detach().cpu()[:, 0]
    peak = float(signal.abs().max())
    noise_std = settings.noise * peak
    if noise_std > 0:
        generator = torch.Generator().manual_seed(0)
        signal = signal + noise_std * torch.complex(torch.randn(signal.shape, generator=generator), torch.randn(signal.shape, generator=generator)) / np.sqrt(2)
    warnings: list[str] = []
    if grid["cartesian"]:
        kgrid = np.zeros((ny, nx), np.complex64)
        kgrid[grid["iy"], grid["ix"]] = signal.numpy()
        kgrid = kgrid[::-1].copy()  # row 0 = +ky
        # Centred inverse FFT; equals MRzero's adjoint reconstruction in magnitude (it is a dense
        # DFT, O(N^4) in time and memory, which does not fit 256^2 into a 16 GB container).
        image = np.roll(np.fft.fftshift(np.fft.ifft2(np.fft.ifftshift(kgrid), norm="forward")), -1, axis=0)
    else:
        warnings.append("the trajectory is not exactly Cartesian; reconstructed with MRzero's adjoint operator and k-space shown as the FFT of the image")
        image = mr0.reco_adjoint(signal[:, None], torch.as_tensor(kspace), resolution=(nx, ny, 1), FOV=(grid["fov"][0], grid["fov"][1], 1))
        image = image[:, :, 0].numpy().T[::-1].copy()  # [y, x], row 0 = +y
        kgrid = np.fft.fftshift(np.fft.fft2(np.fft.ifftshift(image))).astype(np.complex64)
    timing["recoMs"] = (time.perf_counter() - t) * 1e3

    sig = signal.numpy().reshape(-1, samples).astype(np.complex64)
    centre_line = int(np.argmin(np.abs(kspace[::samples, 1])))
    means = _tissue_means(phantom, image, grid["fov"])
    stats = {
        "signalPeak": peak,
        "echoPeak": float(np.abs(sig[centre_line]).max()),
        "centreLine": centre_line,
        "imageMax": float(np.abs(image).max()),
        "imageMean": float(np.abs(image).mean()),
        "noiseStd": noise_std,
        "tissueMeans": means,
        "simResolution": res,
        "repetitions": len(seq),
    }
    arrays = {"signal": sig, "kspace": kgrid.astype(np.complex64), "image": image.astype(np.complex64)}
    return Result(arrays=arrays, stats=stats, timing=timing,
                  grid={"nx": nx, "ny": ny, "fov": grid["fov"], "cartesian": grid["cartesian"], "samplesPerAdc": samples, "adcCount": len(sig)},
                  warnings=warnings)


def write_result(root: Path, key: str, result: Result, meta: dict) -> dict:
    """Write arrays as interleaved little-endian complex64 plus ``meta.json`` under ``root/<key>``."""
    target = root / key
    parts = {}
    if target.exists() and (target / "meta.json").exists():
        return json.loads((target / "meta.json").read_text())["parts"]
    root.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{key[:12]}-", dir=root))
    try:
        for name, array in result.arrays.items():
            file = f"{name}.c64"
            np.ascontiguousarray(array, dtype="<c8").tofile(staging / file)
            parts[name] = {"file": file, "shape": list(array.shape), "dtype": "complex64"}
        (staging / "meta.json").write_text(json.dumps({**meta, "parts": parts}, allow_nan=False))
        for child in staging.iterdir():
            os.chmod(child, 0o644)
        os.chmod(staging, 0o755)
        try:
            os.rename(staging, target)
        except OSError:
            # Another writer stored the same key first; content is identical by construction.
            pass
    finally:
        if staging.exists():
            for child in staging.iterdir():
                child.unlink()
            staging.rmdir()
    return parts

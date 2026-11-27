"""The simulation core without MCP: reconstruction and phantoms."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

from mrzero_mcp.phantoms import tubes
from mrzero_mcp.simulate import Settings, SimulationError, simulate

SEQ = (Path(__file__).parent / "data/gre2d.seq").read_text()


def test_fft_reconstruction_matches_mrzero_adjoint() -> None:
    import MRzeroCore as mr0

    result = simulate(SEQ, tubes(), Settings(), "cpu", lambda done, total: None)
    k = result.arrays["kspace"]
    # Rebuild the acquisition-order signal and reconstruct with MRzero's own adjoint operator.
    seq = mr0.Sequence.import_file(str(Path(__file__).parent / "data/gre2d.seq"))
    signal = torch.as_tensor(result.arrays["signal"].reshape(-1))[:, None]
    ref = mr0.reco_adjoint(signal, seq.get_kspace(), resolution=(64, 64, 1), FOV=(*result.grid["fov"], 1))
    ref = np.abs(ref[:, :, 0].numpy().T[::-1])
    ours = np.abs(result.arrays["image"])
    assert k.shape == (64, 64) and ours.shape == (64, 64)
    np.testing.assert_allclose(ours / ours.max(), ref / ref.max(), atol=1e-3)


def test_settings_are_checked() -> None:
    for bad in ({"resolution": 4}, {"noise": 2}, {"unknown": 1}):
        try:
            Settings.parse(bad)
        except SimulationError:
            continue
        raise AssertionError(f"{bad} was accepted")


def test_tubes_phantom_is_deterministic() -> None:
    assert tubes().content_hash() == tubes().content_hash()
    assert set(tubes().tissues) == {"fat-like", "wm-like", "gm-like", "long-T2", "short-T2", "csf-like"}

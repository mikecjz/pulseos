# mrzero-mcp

An MCP server (stdio) that simulates Pulseq `.seq` files with [MRzero-Core](https://github.com/MRsources/MRzero-Core), a phase distribution graph (PDG) simulator on PyTorch. It implements the PulseOS `pulseos.sim/1` tool contract.

**License: AGPL-3.0-only** (see `LICENSE`), because it imports MRzero-Core. It is a separate program: PulseOS talks to it only over MCP and doesn't import it. Publish this directory's source with any image you distribute or host.

## Tools

| Tool | Result |
|---|---|
| `engine_info` | Protocol, engine, versions (server, MRzero-Core, torch), device, GPU name, license |
| `list_phantoms` | `brainweb-axial` (once prepared) and `tubes`, with content hashes |
| `simulate(seqText, seqHash, phantom, resultKey, settings?)` | Writes `image.c64`, `kspace.c64`, `signal.c64` (interleaved complex64) and `meta.json` to `<out>/<resultKey>/`; returns metadata, stats and timing |

**Settings.** All optional:

| Setting | Default | Meaning |
|---|---|---|
| `resolution` | the sequence matrix (8–256) | Simulation grid |
| `maxStates` | 200 | PDG state budget |
| `minStateMag` | 1e-4 | PDG threshold |
| `minEmitted` | 0.01 | PDG threshold |
| `minLatent` | 0.01 | PDG threshold |
| `noise` | 0 | Complex Gaussian noise, as a fraction of the peak signal |
| `b0` | true | Use the phantom's B0 map |
| `b1` | true | Use the phantom's B1 map |

**Pipeline.** The `.seq` is parsed by MRzero. The Cartesian grid and FOV are inferred from the ADC trajectory. Then the PDG pre-pass and main pass run, and the image is reconstructed by a centred inverse FFT. That FFT equals MRzero's adjoint operator in magnitude, which `tests/test_simulate.py` checks; the adjoint itself is a dense DFT that does not fit 256² into 16 GB. Non-Cartesian trajectories fall back to the adjoint.

**Progress and cancellation.** `notifications/progress` is sent once per sequence repetition, at most 10/s. Cancellation stops the simulation between repetitions. Jobs run one at a time per server.

**Errors.** Errors in the input (unreadable `.seq`, non-Cartesian/2D, unknown phantom, bad settings) are returned as plain messages. Unexpected failures start with `engine error:`.

**stdout.** stdout carries only the MCP stream. At startup the server keeps the original descriptor for MCP and points fd 1 at stderr, so prints from MRzero (Python or Rust) go to stderr.

## Phantoms

All phantoms are 2D (one voxel in z, 3 mm):

- **`tubes`**: six vials with distinct T1/T2 (fat-, WM-, GM- and CSF-like, long T2, short T2), 200 mm FOV, generated in code.
- **`brainweb-axial`**: one 1 mm axial slice of BrainWeb subject 04 through the lateral ventricles. It uses the 3 T tissue values from MRzero's BrainWeb table and synthetic B0/B1 maps. `mrzero-mcp prepare-phantoms --phantoms <dir>` downloads it once (needs network). The Docker image bakes it into `/opt/phantoms` at build time, because the container runs without network. BrainWeb: https://brainweb.bic.mni.mcgill.ca/

## Run

**Docker** (what `ctx.pulseSim` runs by default):

```sh
docker build -t pulseos/mrzero-mcp:dev sims/mrzero-mcp
docker run -i --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
  --memory 16g --gpus device=0 -e MRZERO_DEVICE=cuda \
  -v "$PWD/.pulseos-data/sim:/data:rw" pulseos/mrzero-mcp:dev
```

The image is about 7.5 GB: torch with CUDA 12.8 wheels on `python:3.12-slim`. Those wheels run on the CPU too (`-e MRZERO_DEVICE=cpu`, without `--gpus`).

**Local** (no Docker):

```sh
uv sync --project sims/mrzero-mcp
sims/mrzero-mcp/.venv/bin/mrzero-mcp prepare-phantoms     # ~/.cache/mrzero-mcp/phantoms
sims/mrzero-mcp/.venv/bin/mrzero-mcp serve --out .pulseos-data/sim --device cpu
```

## Measured (Phase 0, lab box: TITAN RTX, 96-core CPU, MRzero-Core 1.6.0, torch 2.11 cu128)

These are measured from the hardened container and reported by the engine; wall time includes the MCP round trip. The phantom is `brainweb-axial`, simulated on a grid that matches the sequence matrix.

| `gre2d` matrix | GPU warm | GPU first call | CPU warm |
|---|---|---|---|
| 64² (64 TRs) | **0.85–1.0 s** (simulate 0.6 s) | 4.0 s (CUDA init) | 0.95–1.07 s |
| 128² (128 TRs) | 1.5 s | — | 4.3 s |
| 256² (256 TRs) | 3.4 s | — | 107 s (outside Docker) |

- **Startup.** A cold container start through MCP `initialize` takes 2.2–3.0 s.
- **Cancellation.** It takes effect at the next repetition, about 10 ms apart at 64² on the GPU.
- **Progress.** Ten notifications per second at most; 8–12 per 64² run.

## Tests

```sh
uv run --project sims/mrzero-mcp pytest sims/mrzero-mcp/tests       # or: pnpm run test:sim
```

The tests use the `tubes` phantom on the CPU. `tests/test_server.py` drives the server over real MCP stdio: the tool list, a simulation with progress, input errors, and cancelling mid-run with the server still answering afterwards.

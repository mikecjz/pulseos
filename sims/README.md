# Simulation engines

Each directory is a standalone **MCP server** that implements the `pulseos.sim/1` tool contract (`packages/sim/protocol`). PulseOS reaches engines only through `ctx.pulseSim` (`packages/sim/service`), over MCP on stdio. Engines never import PulseOS code, and PulseOS never imports theirs.

| Engine | Directory | License | Status |
|---|---|---|---|
| MRzero (PDG, PyTorch) | `mrzero-mcp/` | **AGPL-3.0-only** (its own `LICENSE`) | Docker image; local uv environment |
| KomaMRI.jl | `koma-mcp/` | MIT | planned (POS-15) |

The MRzero server is AGPL because it imports MRzero-Core. Keeping it in its own directory, process and image is what lets the rest of PulseOS stay unaffected. If a hosted or distributed PulseOS ships this image, publish this directory's source with it.

## Quick start (lab GPU box)

```sh
docker build -t pulseos/mrzero-mcp:dev sims/mrzero-mcp     # ~7.5 GB; bakes in the BrainWeb slice
pnpm run web                                               # engine "mrzero": docker, --gpus device=0
```

To use another GPU, the CPU, or no Docker, override `engines.mrzero` in a patch file (see `packages/sim/service/README.md`):

```yaml
- id: pulseos-sim-service
  config:
    engines:
      mrzero: { gpu: 2 }                        # or gpu: null for CPU in Docker
      # mrzero: { launcher: local, device: cpu } # sims/mrzero-mcp/.venv, no Docker
```

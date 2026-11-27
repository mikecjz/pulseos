# @pulseos/sim-service

`ctx.pulseSim` is the only MCP client of the PulseOS simulation engines. It turns a sequence revision into its `.seq` text and runs it on an engine. It also caches results by content, queues jobs, and records every run in the session log. The panel routes and the `sim_*` model tools both go through it. The model never talks to an engine directly.

## Service

| Method | Purpose |
|---|---|
| `run(session, request, signal?)` | Queue a simulation of `request.rev` (default: the latest revision) on `request.phantom` with `request.engine`. Returns `{id, done}`; `done` resolves to the recorded run or failure. |
| `cancel(session, id?)` | Cancel one job, or every job of the session. A running job stops at the engine's next checkpoint. |
| `state(session)` | Runs and the last failure, folded from the session log. |
| `jobsOf(session)` | Queued and running jobs with live progress (in memory). |
| `engines()` / `connect(engine?)` | Engine status (`stopped`, `starting`, `ready`, `unavailable` with the error and stderr tail), identity and phantoms; `connect` starts one. |
| `result(key)` / `part(key, part)` | Stored metadata and arrays, with size checks. |
| `onChange(listener)` | Job and engine changes. |

### How a run works

1. The service reads the revision's `.seq` from `ctx.pulseSeq.seqPath` and hashes it.
2. It starts the engine if needed and looks up the phantom's content hash.
3. It computes the result key: `sha256(protocol, seqHash, engine, engineVersion, phantomHash, settings)`. If `dataDir/sim/<key>/meta.json` already exists, it records the run as `cached` without calling the engine.
4. Otherwise it calls `simulate` with the `.seq` text inline. Progress feeds `jobsOf`; the deadline is `timeoutMs`.
5. It appends `plugin:pulseos/sim-run` or `plugin:pulseos/sim-failed`.

Each engine runs one job at a time; jobs from all sessions share that queue. A newer request from the same session for the same phantom supersedes an older one that hasn't started yet; superseded jobs aren't recorded.

### Engines and launchers

Engines are configured by ID under `engines`. Each one is a process the service owns: it starts on first use, starts again on the next call after a crash, and stops after `idleShutdownMs` without work.

| `launcher` | Process |
|---|---|
| `docker` (default) | `docker run -i --rm` with `--network none`, `--read-only`, a tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, `--user <host uid:gid>` (never root), `--pids-limit`, `--memory`, and one writable mount: `dataDir/sim` → `/data`. `gpu: N` adds `--gpus device=N`; `gpu: null` runs on the CPU. |
| `local` | `command` plus `--out <dataDir/sim> --device <device>`, e.g. the `sims/mrzero-mcp` uv environment without Docker. |
| `fake` | `src/fake-engine.ts`: a real MCP server over stdio that draws analytic vials. Used by tests and CI. |

The service creates `dataDir/sim` before it starts an engine, because Docker would otherwise create a missing mount source owned by root. Running Docker means the user running pulseos can effectively act as root on the host; rootless Docker avoids that.

### Configuration

| Key | Default |
|---|---|
| `dataDir` | `<repo>/.pulseos-data` (results in `dataDir/sim`) |
| `engines` | `{ mrzero: { launcher: docker, image: pulseos/mrzero-mcp:dev, gpu: 0, memory: 16g } }` |
| `defaultEngine` / `defaultPhantom` | `mrzero` / `brainweb-axial` |
| `timeoutMs` | 600000 |
| `connectTimeoutMs` | 180000 (Docker start plus torch import) |
| `idleShutdownMs` | 900000; `0` keeps engines running |

For example, a CPU-only machine without Docker would add this patch:

```yaml
- id: pulseos-sim-service
  config:
    engines:
      mrzero: { launcher: local, device: cpu }
```

## Model Experience

### No model-visible surface

#### What the model sees

None directly. `@pulseos/sim-tools` turns runs into tool results. The session records are `ignorable` plugin records and are not projected into the model's context.

#### Token effect

None.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **No store pruning.** Results in `dataDir/sim` are never removed (plan Phase 6: LRU pruning).
- **Queue per engine, not per GPU.** Two engines configured on the same GPU can run at the same time.
- **The service doesn't verify stored arrays against their key.** It checks their sizes; the key is a content hash of the inputs, not of the outputs.
- **Progress is not durable.** After a host restart, jobs in flight are lost without a failure record.

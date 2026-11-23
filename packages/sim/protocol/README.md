# @pulseos/sim-protocol

The simulation contract shared by the engines, the DSH host plugins and the browser page. It is plain TypeScript with no runtime dependencies, so the page can bundle it.

- **`pulseos.sim/1` MCP tool contract.** Every engine is an MCP server with three tools:
  - `engine_info()` returns `{protocol, engine, title, version, engineVersion, device, gpu, license}`.
  - `list_phantoms()` returns `{phantoms: [{id, title, description, dims, fov, tissues, hash}]}`.
  - `simulate({seqText, seqHash, phantom, resultKey, settings?})` writes `image.c64`, `kspace.c64`, `signal.c64` and `meta.json` to `<result dir>/<resultKey>/`, and returns `{resultKey, parts, stats, timing, grid, warnings, device, phantomHash}` as `structuredContent`.
  - Arrays are interleaved little-endian complex64, row-major. Large data never travels in MCP messages.
  - An error result is shown to the user. Text starting with `engine error:` means a failure inside the engine; any other error result means the input can't be simulated.
  - `simulate` reports `notifications/progress` when the caller sends a progress token, and stops when the caller cancels.
- **Reply checks.** Engines run out of process, so their replies are input. `parseSimulateReply`, `parseEngineInfo` and `parsePhantoms` reject replies that are malformed or that name files outside the result directory.
- **Session records.** Two DSH plugin records (`ignorable`): `plugin:pulseos/sim-run` (`SimRunRecord`: revision, engine and version, phantom, settings, result key, stats, grid, timing, cached flag) and `plugin:pulseos/sim-failed` (`SimFailedRecord`: the error kind is `unavailable`, `input`, `engine`, `timeout`, `cancelled` or `superseded`).
- **Status types.** `SimJob`, `EngineState` and `Progress` describe in-memory host state for the panel.
- **References.** `[[sim:r<rev>/<phantom>]]`, or `[[sim:r<rev>/<phantom>@<engine>]]` for a non-default engine. `findSimReferences` and `formatSimReference` handle them. `sim:` is reserved: `@pulseos/seq-protocol`'s `findReferences` skips it.

## Model Experience

### No model-visible surface

#### What the model sees

None. This package defines types and pure functions. `@pulseos/sim-tools` decides what reaches the model.

#### Token effect

None.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **2D Cartesian only.** `grid` describes one Cartesian 2D acquisition. Non-Cartesian and 3D results need a richer grid description.

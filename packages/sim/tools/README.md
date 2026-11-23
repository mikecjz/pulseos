# @pulseos/sim-tools

Model-facing simulation tools, plus `[[sim:...]]` references in user messages. Both act on the calling agent's session through `ctx.pulseSim`.

| Tool | Does |
|---|---|
| `sim_run` | Simulates a revision (default: the latest) on a phantom (default `brainweb-axial`), waits for the result, and returns a compact summary. Optional: `engine`, `noise`, `resolution`. The run also appears in the user's Simulation panel. |
| `sim_summary` | Summarizes a recorded run without simulating again. Default: the latest run. |

A summary gives the run's reference token, engine and device, and the acquisition grid. It quotes the revision's contrast parameters (TE, TR, TI and flip angle, when the recipe has them) and the signal peaks. It lists the mean image magnitude per tissue, brightest first and relative to the brightest, and the largest contrast ratio. It also compares each tissue with the previous run on the same phantom. It never includes arrays.

These are expected failures, thrown as `HarnessError`s so the model sees `Error: ...`: no sequence yet, an unknown revision or engine (`PULSEOS_SIM_STATE`), and a failed simulation with its kind (`PULSEOS_SIM_FAILED`).

**References.** Before a model step, each user message that contains `[[sim:r<rev>/<phantom>]]` tokens is followed by one context message. Its source kind is `pulseos-sim-reference`, and it holds the summary of each referenced run (the latest run of that revision and phantom), or `unresolved`. At most 8 tokens per message are expanded.

## Model Experience

### Tool schemas

#### What the model sees

Two tool schemas, written in `src/index.ts`. Both end with this sentence:

##### Verbatim citation instruction

```markdown
Cite runs in replies as [[sim:r<rev>/<phantom>]] so the user can open them in the Simulation panel.
```

#### Token effect

About 350–450 tokens for the two schemas (estimated from their character count), on every request.

#### KV Cache effect

The schemas are part of the stable tool prefix. They change only when this plugin is loaded, unloaded or reconfigured.

### Tool results

#### What the model sees

Plain-text summaries. `apps/pulseos/tests/__snapshots__/headless-sim-tool-results.md` shows a scripted run that builds, simulates, changes the flip angle, simulates again (once from the cache) and summarizes. That run uses the fake engine.

#### Token effect

About 8–10 lines per summary (roughly 150–250 tokens), and one line more for the comparison.

#### KV Cache effect

Results are appended to the conversation.

### Simulation reference context

#### What the model sees

One `user/message` after a user message with `[[sim:...]]` tokens. It's wrapped in `<simulation-references>` and holds one summary per token. It is logged with source kind `pulseos-sim-reference`, so the model's input can be rebuilt from the session log.

#### Token effect

One summary per distinct token (up to 8), or one line for an unresolved token.

#### KV Cache effect

The message is appended after the user's message and doesn't change earlier tokens.

## Known Limitations and Deferred Work

- **Image magnitude only.** Tissue means are image magnitudes inside voxels that are at least 80% one tissue. There is no SNR estimate without noise, and no artefact detection yet.
- **No assistant-text highlighting** for `[[sim:...]]` tokens. The chips render in user messages only.

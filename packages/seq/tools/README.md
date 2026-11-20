# @pulseos/seq-tools

Model-facing tools for the session's pulse sequence. Every tool acts on the calling agent's session through `ctx.pulseSeq`. Every build becomes a revision.

| Tool | Does |
|---|---|
| `seq_status` | Current revision, parameters (with IDs, units and SI values), roles with their event IDs, markers and a timing summary |
| `seq_build` | Build a bundled recipe (`gre2d`) as a new revision, with optional parameter overrides |
| `seq_set_params` | Change parameters (SI units) and rebuild |
| `seq_get_element` | Describe one element at a revision: timing, amplitudes, how it varies across instances, timing errors and the recipe lines that emit it |
| `seq_get_recipe` | Recipe source with line numbers |
| `seq_edit_recipe` | Exact-match text edits (each `old_text` must occur once) or a whole new source, then rebuild |
| `seq_check_timing` | pypulseq timing errors with element IDs |
| `seq_diff` | Parameter changes, role changes and the unified recipe diff between two revisions |
| `seq_restore` | Rebuild an earlier revision as a new one |

These are expected failures: a failed build (with error kind and recipe line), a missing sequence or revision, and invalid arguments. They are thrown as `HarnessError` subclasses (`PULSEOS_BUILD_FAILED`, `PULSEOS_NO_SEQUENCE`, `INVALID_ARGS`), so the model sees `Error: ...`. After a failed build the current revision is unchanged.

## Model Experience

### Tool schemas

#### What the model sees

Nine tool schemas, whose descriptions are written in `src/index.ts`. `seq_status`, `seq_get_element` and `seq_check_timing` all end with this sentence:

##### Verbatim citation instruction

```markdown
Cite sequence elements in replies as [[<element id>]], e.g. [[gre2d:excitation.rf]], so the user can click them.
```

#### Token effect

The nine schemas add a fixed cost to every request: about 1–1.5k tokens of descriptions and parameter schemas (estimated from their character count).

#### KV Cache effect

The schemas are part of a stable, repeated prefix. They change only when this plugin is loaded, unloaded or reconfigured.

### Tool results

#### What the model sees

Plain-text results. `apps/pulseos/tests/__snapshots__/headless-tool-results.md` holds one result of each tool, from a scripted run, with hashes normalized.

#### Token effect

Results grow with the sequence:
- `seq_status`: about 30 lines for gre2d.
- `seq_get_recipe`: the whole recipe.
- `seq_check_timing`: at most 20 errors.
- `seq_get_element`: the first instance plus a summary of what varies.

#### KV Cache effect

Results are appended to the conversation, so earlier tokens are never replaced.

## Known Limitations and Deferred Work

- **One bundled recipe** — only `gre2d` exists; `seq_build` accepts any bundled name.
- **No direct `.seq` download tool** — the file is stored with each revision (`ctx.pulseSeq.seqPath`); the viewer exposes it in M4.

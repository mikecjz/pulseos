# pulseos-seq

The pypulseq backend of PulseOS. A **recipe** (a Python file) builds a sequence through `SeqBuilder`, which gives every block and event a stable, recipe-chosen **element ID** and records its timing, content, fingerprint and recipe source lines. The result is a **sequence model** (JSON, schema `pulseos.sequence/1`) that the DSH plugins and the viewer consume, plus an optional `.seq` file.

## Recipes

```python
import pypulseq as pp
from pulseos_seq import param

SEQUENCE = "gre2d"                                   # ID prefix
PARAMS = {"TE": param(4.2e-3, "s", "Echo time", min=0.5e-3, max=100e-3), ...}

def build(b, p):                                     # b: SeqBuilder, p: resolved Params
    for line in b.loop("line", range(p.Ny)):         # loop index -> @line=<i> in instance IDs
        b.block("excitation", rf=rf, gz=gz)          # role "excitation", events "rf" and "gz"
        b.block("readout", gx=gx, adc=adc)
        if line == 0:
            b.mark("TE", echo_time, start=rf_centre) # timing marker, selectable as gre2d:param.TE
```

- **Roles** name what a block does. One role comes from exactly one `b.block(...)` call in the recipe, and is added at most once per combination of loop indices; repetitions go through `b.loop(...)`. Breaking either rule fails the build with the recipe line.
- **Events** are the keyword arguments of `b.block`; `None` skips an event. Delays and labels are allowed but are not elements.
- **Renames** are declared: `b.block("rf_excite", formerly="excitation", ...)`. References to `excitation` then resolve to `rf_excite`. An undeclared rename is a removed role plus an added role.
- `pulseos_seq/recipes/gre2d.py` is the bundled 2D spoiled GRE.

## Templates and adopted sequences

`pulseos_seq/recipes/templates.json` lists the templates the viewer offers: `gre2d` first, then `pypulseq_*` recipes vendored from pypulseq's example scripts (`write_gre.py`, `write_epi.py`, `write_tse.py`, `write_mprage.py`, ...; MIT, see `recipes/LICENSE-pypulseq`). `python/tools/vendor_pypulseq_examples.py <pypulseq checkout>` regenerates them: it keeps the example's `main()`, removes plotting, the test report and `.seq` writing, swaps standard-library imports that recipes may not use for their `pulseos_seq` re-exports (`copy`, `SimpleNamespace`, `warn`), and appends `SEQUENCE`, an empty `PARAMS` and `build(b, p): b.adopt(main())`.

`b.adopt(seq)` takes a complete pypulseq `Sequence` built elsewhere and records its blocks with roles derived from their contents (`pulseos_seq.adopt`):

- base name from the events: the RF pulse's `use` (`excitation`, `refocusing`, `inversion`, ...), else `readout` for an ADC, else `grad_<axes>` (`grad_xyz`), else `trigger` or `delay`;
- blocks with the same base name but different event channels, kinds or durations are separate roles, numbered by first appearance (`grad_xyz_2`); amplitudes may differ, so phase-encode steps and radial spokes stay one role;
- loop `rep` counts repetitions, each starting at an excitation (or, without excitations, at the first RF role); a role that occurs more than once in one repetition also gets the inner loop `n` (`epi:readout.adc@rep=1,n=12`). Inner loops are marked `"inner": true` in `loops` and do not start a new repetition.

Adopted blocks have no recipe source spans, and `adopt` must be the only way blocks are added. `read_sequence(path, name, profile)` uses the same derivation to render a `.seq` file: the model's `seq` is the file's `Name` definition (else the file name), `recipe.file` is the file name, and `params` and `markers` are empty.

Recipe source is checked before it runs (`pulseos_seq.recipe.check_source`): imports are limited to `pulseos_seq`, `pypulseq`, `numpy` and `math`; dunder attributes and `open`/`eval`/`exec`/`getattr`-style builtins are rejected; the module runs with a reduced builtins table. This is defence in depth: the DSH sequence service runs each build in a separate, confined process.

## Element IDs

`<seq>:<role>[.<event>][@<loop>=<i>,...]`, plus `<seq>:param.<name>` for parameters and `<seq>:marker.<name>` for markers that are not parameters.

| ID | Element |
|---|---|
| `gre2d:excitation` | every excitation block (role) |
| `gre2d:excitation.rf` | every excitation RF pulse |
| `gre2d:readout.adc@slice=0,line=64` | one ADC event |
| `gre2d:param.TE` | the TE parameter and its marker |

`pulseos_seq.resolve.resolve(model, id)` returns `ok` with the element or `gone` with a reason; it never returns a different element. `resolve_between(old, new, id)` also follows declared renames and reports `same` / `changed` by fingerprint. `role_diff(old, new)` lists added, removed, renamed, changed and unchanged roles.

## Sequence model

Units: time s, gradients mT/m, RF magnitude uT, phase rad, flip angle deg.

| Key | Content |
|---|---|
| `seq`, `recipe.hash`, `pypulseqVersion`, `profile` | identity of the build inputs |
| `params` | name → `{id, value, default, unit, description, min, max, integer, fingerprint}` |
| `loops` | loop names and sizes, outermost first; `inner: true` marks a loop within one repetition |
| `roles` | `{role, id, events[{name, channel, id, fingerprint, instances}], sourceSpan{startLine, endLine}, formerly, instances, fingerprint}` |
| `blocks` | `{id, index, role, loop, t0, duration, fingerprint}` in time order |
| `events` | `{id, block, role, name, channel, loop, t0, fingerprint, kind, delay, duration, ...}`; `kind` is `rf` (`shape`, `peak`, `flipAngle`, `freqOffset`, `phaseOffset`), `trap` (`amplitude`, `rise`, `flat`, `fall`, `area`), `grad` (`shape`, `peak`, `area`) or `adc` (`numSamples`, `dwell`, `phaseOffset`) |
| `shapes` | shape id → `{t, value, phase?}`, shared by every event that uses the same waveform |
| `markers` | `{id, name, t, start, loop}` |
| `timing` | pypulseq `check_timing` result; each error lists the element IDs of its block |

**Fingerprints** are sha256 hashes of an element's content: duration, delay within its block, amplitudes, waveform, phase and frequency offsets. They exclude absolute start times, so an element that only moves in time keeps its fingerprint. A role's fingerprint covers all of its instances.

## Build runner

`python -m pulseos_seq.run` reads one JSON request on stdin and writes one JSON result on stdout:

```json
{"recipe": {"path": "/abs/recipe.py"}, "params": {"TE": 0.004},
 "profile": {"id": "generic", "directory": "/abs/profiles/scanner"}, "seqPath": "/abs/out.seq"}
```

`{"recipe": {"bundled": "gre2d"}}` selects a bundled recipe. `{"seqFile": {"path": "/abs/upload.seq", "name": "my.seq"}}` instead of `recipe` reads a `.seq` file (after confinement) and returns its model. The result is `{"ok": true, "model": {...}}` or `{"ok": false, "error": {"kind", "message", "line", "traceback"}}`, where `kind` is `check`, `params`, `build`, `runtime`, `read`, `profile` or `io`. A recipe failure exits 0; a malformed request exits 2.

## Tests

```sh
uv run --project python pytest python/tests
```

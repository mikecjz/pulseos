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
| `loops` | loop names and sizes, outermost first |
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

`{"recipe": {"bundled": "gre2d"}}` selects a bundled recipe. The result is `{"ok": true, "model": {...}}` or `{"ok": false, "error": {"kind", "message", "line", "traceback"}}`, where `kind` is `check`, `params`, `build`, `runtime`, `profile` or `io`. A recipe failure exits 0; a malformed request exits 2.

## Tests

```sh
uv run --project python pytest python/tests
```

# @pulseos/seq-protocol

The contract shared by the Python backend, the DSH host plugins and the browser viewer. It is plain TypeScript with no runtime dependencies, so the viewer can bundle it.

- **Element IDs**: `parseElementId` / `formatElementId` implement the grammar of `pulseos_seq.ids`: `<seq>:<role>[.<event>][@<loop>=<i>,...]`, `<seq>:param.<name>`, `<seq>:marker.<name>`.
- **Sequence model**: `SequenceModel` and its element types mirror the `pulseos.sequence/1` JSON produced by `pulseos_seq.model`.
- **Resolution**:
  - `resolve(model, id)` returns `ok` or `gone`.
  - `resolveBetween(older, newer, id)` returns `same`, `changed` or `gone`, following declared `formerly` renames.
  - `roleDiff` and `paramChanges` compare two models.

  These behave like `pulseos_seq.resolve`. `tests/protocol.spec.ts` runs both on the same gre2d models and compares the results.
- **Session records**: `RecipeRecord`, `RevisionRecord` and `BuildFailedRecord` are stored as DSH plugin records (`plugin:pulseos/recipe`, `plugin:pulseos/revision`, `plugin:pulseos/build-failed`).
- **Reference tokens**: `[[<element id>]]` points at the latest revision, and `[[<element id>|r<rev>]]` pins a revision. `findReferences(text)` returns every token and marks malformed IDs `valid: false`, so the UI can show them as unresolved. `formatReference` writes a token. The sequence name `sim` is reserved: `[[sim:...]]` tokens are simulation references (`@pulseos/sim-protocol`) and are skipped.

## Model Experience

### No model-visible surface

#### What the model sees

None. This package defines types and pure functions. The sequence tools and the reference plugin decide what reaches the model.

#### Token effect

None.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **One sequence per session** — records carry the sequence name, but the service tracks one current recipe per session.

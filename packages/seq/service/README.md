# @pulseos/seq-service

`ctx.pulseSeq` builds PulseOS sequences and keeps their history. It runs each build in a separate, confined Python process, records every build in the session log, and stores the resulting models by content address.

## Service

| Method | Purpose |
|---|---|
| `build(session, request, signal?)` | Build one revision. `request` gives `cause`, `author`, and any of: `params` (strict overrides), `recipeSource` (code edit), `bundled` (start from a bundled recipe), `restore` (rebuild an earlier revision). Builds of one session run one at a time. |
| `state(session)` | Recipes, revisions and the last failure, folded from the session log. |
| `current(session)` / `revision(session, rev)` | Revision records. |
| `recipe(session, rev?)` | Recipe source of a revision, or of the next build. Before the first build this is the default bundled recipe. |
| `model(hash)` / `modelOf(session, revision)` | Load a stored model. `modelOf` rebuilds it from the recorded recipe and parameters when the store no longer has it, for example after moving machines. |
| `seqPath(revision)` | Path of the revision's `.seq` file. |
| `templates()` | The template catalogue (`templates.json` in `recipeDirectory`): `gre2d` and pypulseq's example sequences. Build one with `build(session, { bundled: name })`. |
| `readSeq(bytes, fileName, signal?)` | Render a `.seq` file as a model in the same confined runner. Nothing is recorded in a session. |

### Session records

Every build appends DSH plugin records (`ignorable`, so a DSH without this plugin can still read the session):

- `plugin:pulseos/recipe`: the full source of each new recipe version, its parent, a unified diff and the cause.
- `plugin:pulseos/revision`: revision number, parent, kind (`init` | `param` | `code` | `restore`), cause, author, recipe and parameter hashes, the parameter values, the scanner profile, the pypulseq version, the model hash, a timing summary, the parameter delta, the role diff and the recipe diff.
- `plugin:pulseos/build-failed`: a build that produced no revision, with the error and the recipe line.

The current recipe and parameters are always those of the latest revision. A failed build changes neither. Revisions are never rewritten; restoring an old revision creates a new one.

### Builds and confinement

Each build follows these steps:

1. Write the recipe to a fresh `mkdtemp` directory with mode `0700`.
2. Run `python -I -B -m pulseos_seq.run` there through `ctx.subprocess`, with a scrubbed environment, a wall-clock deadline (`timeoutMs`) and a bounded output (`maxOutputBytes`).
3. Remove the directory.

With `confine: true` (the default), the runner reads its inputs and then confines itself with Landlock before any recipe code runs. After that it can:

- read only the Python installation,
- write only its build directory,
- not open TCP connections or listening sockets.

If the kernel's Landlock ABI is older than 4, the build fails with kind `sandbox` rather than running unconfined. The recipe check (an import allowlist and forbidden names) runs as well, as defence in depth.

## Config

| Key | Default | Meaning |
|---|---|---|
| `python` | `python/.venv/bin/python` in this repository | Interpreter with `pulseos-seq` installed. |
| `recipeDirectory` | `python/pulseos_seq/recipes` | Bundled recipes and the template catalogue `templates.json`. |
| `dataDir` | `.pulseos-data` | Model store (`models/<hex>.json`, `seq/<hex>.seq`). |
| `timeoutMs` | `120000` | Build deadline. |
| `graceMs` | `2000` | Terminate-to-kill grace period. |
| `maxOutputBytes` | 256 MiB | Largest accepted model JSON. |
| `confine` | `true` | Landlock confinement; fails closed. |
| `defaultRecipe` | `gre2d` | Recipe of the first build. |
| `modelCacheSize` | `16` | Parsed models kept in memory. |

Paths must be absolute. The service injects `scannerProfile`, `subprocess` and `sessionProjections`.

## Model Experience

### No direct model-visible surface

#### What the model sees

Indirectly, through the tools of `@pulseos/seq-tools`. The session records are plugin records, which DSH never sends to the model.

#### Token effect

None directly.

#### KV Cache effect

None directly.

## Known Limitations and Deferred Work

- **Linux-only confinement** — on other platforms set `confine: false`, which runs builds unconfined; only the recipe check remains.
- **UDP is not confined** — Landlock ABI 4 rules cover TCP only. The recipe check is what blocks socket imports.
- **The store is never pruned** — models and `.seq` files accumulate in `dataDir`.

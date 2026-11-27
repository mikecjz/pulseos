# @pulseos/sim-viewer

The Simulation page: host routes, plus a right-sidebar page in the DSH Web client that shows the session's simulated image, k-space and ADC signal.

## Host routes

All routes go through the authenticated DSH connection.

| Route | |
|---|---|
| `GET /api/pulseos.sim.state?sessionId=` | Runs, last failure, jobs with progress, engines with status and phantoms, defaults, and revisions |
| `GET /api/pulseos.sim.result?key=&part=image\|kspace\|signal\|meta` | A stored array (complex64 bytes, with the shape in `x-pulseos-shape`) or the result metadata. Immutable and cacheable. |
| `POST /api/pulseos.sim.run?sessionId=&rev=&engine=&phantom=` | Queue a simulation; replies `202 {id}` at once. Returns 409 when there is no sequence or no such revision or engine. |
| `POST /api/pulseos.sim.cancel?sessionId=&id=` | Cancel a job, or every job of the session. |
| `POST /api/pulseos.sim.connect?engine=` | Start an engine and list its phantoms (Retry for an unavailable engine). |

## The page

The page type is `pulseos-simulation`, titled "Simulation".
- **When it opens.** It opens as a tab beside the Sequence tab when a simulation starts or lands live, from chat or from the page. Replayed history doesn't open it. If the user closes it, it stays closed for that session until they reopen it from the sidebar's "+" ("Sequence simulator") or click a `[[sim:...]]` chip.
- **Theme.** It follows DSH's active theme and uses the sequence viewer's tokens.

```
┌ rev [latest (r3) ▾]  phantom [BrainWeb brain ▾]  [● mrzero cuda:0 ▾]        [▶ Simulate] ┐
├ ◌ Simulating r3 · brainweb-axial · 23/64 repetitions  ██████░░░░░░        [Cancel]       ┤  while a job runs
├ [stale] The sequence changed since this run (r2 → r3).  Simulate r3                       ┤  or failed / unavailable + Retry
├ run [latest (r3 · brainweb-axial) ▾]  [Image|k-space|Signal]  [|M| ∠]   [Reference in chat] ┤
│                                                                                           │
│                          square canvas: |image|, ∠image, log|k| or |signal|               │
│                                                                                           │
├ fat 513 ██████████████████████████  1.00                                                   ┤  mean per tissue
│ wm  207 ██████████                  0.40                                                   │
├ mrzero 1.6.0 · cuda:0 · 1.04 s (graph 19 ms · simulate 691 ms · recon 1 ms) · 64×64 · FOV 256 mm ┘
```

**States**

| State | What the page shows |
|---|---|
| No sequence | "No sequence built yet" |
| No run yet | A button that simulates the latest revision on the default phantom |
| Running | A progress bar with repetitions done out of the total, and a queue count |
| Failed | The error, with Retry using the same revision, phantom and engine |
| Engine unavailable | The launcher error and stderr tail, with Retry |
| Stale | The shown run's revision is older than the latest; one click simulates the latest revision |

**Views**

| View | Content |
|---|---|
| Image | Magnitude, or phase masked below 5% of the peak |
| k-space | Log magnitude |
| Signal | Magnitude per ADC line, in acquisition order. The k-space centre line is tinted. Hovering a line names its ADC element (`gre2d:readout.adc@slice=0,line=32`), taken from the sequence model. |

**Chat**

- "Reference in chat" inserts a `[[sim:r<rev>/<phantom>]]` chip into the composer.
- Typing `@` offers a "Simulation" group of recorded runs.
- Sent chips render as "sim <phantom> r<rev>". Clicking one opens the page on that run.

**Phantom picker.** An engine lists its phantoms only once it has started. Until then the picker offers the default phantom and the phantoms already used.

## Model Experience

### Reference tokens the page inserts into user messages

#### What the model sees

Indirectly, through user text. "Reference in chat" and the `@` source insert `[[sim:r<rev>/<phantom>]]`. `@pulseos/sim-tools` adds the run summary for each token. The page itself sends nothing to the model.

#### Token effect

Indirectly, through user text: one short token per inserted reference, plus the summary `@pulseos/sim-tools` adds for it.

#### KV Cache effect

Indirectly, through user text, which is appended to the conversation.

## Known Limitations and Deferred Work

- **The UI spec is not from the UI Designer.** The UI Designer agent couldn't be invoked for this run (POS-14), so the layout above follows the M4 viewer spec and still needs design review.
- **Not yet built:**
  - a diff view between two runs;
  - a click on a signal line that selects the ADC in the Sequence tab (hover names it, but there is no cross-tab navigation);
  - window/level controls;
  - export of the arrays;
  - assistant-text highlighting of `[[sim:...]]`.
- **2D only.** Non-Cartesian trajectories are shown with the engine's adjoint reconstruction, and k-space as the image's FFT.

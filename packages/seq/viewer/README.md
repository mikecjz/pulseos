# @pulseos/seq-viewer

The PulseOS sequence viewer for the DSH Web client. DSH's own conversation is the chat on the left; this package adds the waveform viewer on the right and makes `[[element id]]` references clickable on both sides. It follows the M4 UI spec and the accepted mockup on POS-4.

The package has two faces:
- **Host face** (`src/index.ts`): read-only HTTP routes on live sessions.
- **Browser face** (`src/client/`): a DSH client plugin, built with DSH's `clientBundle` preset into `lib/client.js` (`pnpm run build` at the repository root).

## Host routes

All routes take `sessionId`; `rev` defaults to the latest revision. The browser calls them through the authenticated DSH connection.

| Route | Returns |
|---|---|
| `GET /api/pulseos.state` | revision records, the last failure, whether a build is running, the scanner profile |
| `GET /api/pulseos.model?rev=` | the sequence model JSON (rebuilt from the recorded recipe if the store lost it) |
| `GET /api/pulseos.recipe?rev=` | recipe source |
| `GET /api/pulseos.seq?rev=` | the `.seq` file as a download |
| `POST /api/pulseos.build` | the empty state's "Build gre2d with defaults"; refused once a sequence exists, because later changes go through chat |

## Browser

### Viewer tab

The viewer is a right-sidebar page type, `pulseos-sequence`.

- **Opens by default:** whenever a session comes on screen without a Sequence tab, the viewer opens in the right sidebar, even before any build. A session without a revision therefore shows the empty state right away. DSH creates a session with its first message, so the start page has no viewer yet.
- **Closing is respected:** if the user closes the Sequence tab, it stays closed for that session: on later messages, new revisions and page reloads. The choice is stored per session in `localStorage`. A Sequence tab inside a collapsed sidebar is left collapsed.
- It is also listed in the right sidebar's guide as "Sequence viewer".

- **Toolbar:**
  - sequence name;
  - revision picker (newest first, with kind, cause and timing); an older revision is shown read-only with a "Back to latest" banner;
  - Fit all, 1 TR, 2 TR, Selected;
  - TR stepping;
  - scanner-profile badge (the limits are in its tooltip);
  - timing counter, which cycles through violations;
  - `.seq` export.
- **Overview strip:** the whole sequence with alternating repetition shading, RF positions and a draggable viewport brush.
- **Tracks** in the default order RF |B1|, RF phase (collapsed, expandable), Gz, Gy, Gx, ADC, under a time ruler and a lane of pulseq blocks labelled by role.
  - The three gradient tracks share one scale, with dashed lines at the scanner profile's ±max gradient.
  - TE and TR markers are drawn and can be selected (`gre2d:param.TE`).
  - Tracks can be hidden.
  - A cursor readout shows t and every channel's value.
- **Navigation:**
  - Ctrl/⌘ + wheel zooms around the cursor; the wheel or a drag pans; dragging on the ruler zooms to that range; double-click zooms to an element.
  - Keys: `+`/`−` zoom, `←`/`→` pan, `[`/`]` previous/next TR.
- **Selection:**
  - Click selects an element at role level, so all of its instances are highlighted and everything else is dimmed. Shift- or Alt-click selects one instance.
  - Clicking a block label selects the role.
  - `Esc` clears the selection; `R` references it in chat.
- **Inspector** (read-only):
  - The header shows the element ID with a copy button, the revision, the number of instances in view, and the actions Zoom to, All instances and Reference in chat.
  - Tabs: Properties (values, and what varies across instances), Changes (parameter delta, role diff and recipe diff against the parent revision) and Timing.
  - It shows the fingerprint status against the parent revision.
  - It shows the recipe lines that emit the element, with a "Discuss in chat" action.
- **States:**
  - empty: "No sequence built yet", with a build action;
  - building: a spinner on the revision control;
  - build failed: a banner with the error and recipe line, the traceback, and "Reference error in chat", while the last good revision stays shown;
  - backend unavailable: a banner with Retry;
  - timing violations.
- **Theme:** the viewer follows DSH's active theme. It reads the color scheme from DSH's theme service (`ctx.theme`, `@deepseek-ai/dsh-client-ui-theme`) and repaints in place on `theme/change`, so switching Appearance in DSH settings, or the OS scheme while DSH follows the system, re-themes the waveforms, overview and panels without a reload. A registered DSH theme uses the light or dark palette its `colorScheme` builds on. There is no separate viewer switch.
- **Live update:** a new revision re-renders in place, keeping zoom and selection; it reopens the viewer unless the user closed it for that session. A selection that no longer resolves is cleared with a toast. Changed events flash amber for 1.5 s.

### References in chat

- **Composer:** "Reference in chat" (or `R`) inserts a chip for `[[<id>|r<rev>]]`. Typing `@` offers a "Sequence" group of elements to insert the same way. The model receives the token text, and `@pulseos/seq-refs` adds the element's description.
- **Sent user messages:** tokens render as chips through a user-text rule.
  - A chip shows a channel dot, a short label and the revision badge.
  - States: current; changed (amber `r1→r2`); gone (struck through); unresolved (red).
  - Chip and assistant-reference colors switch with DSH's palette selector, `body[data-ds-dark-theme]`.
  - Hovering highlights the element in the viewer. Clicking opens the viewer and selects the element, switching to the chip's revision when the element is gone now.
- **Assistant text:** DSH has no inline-token seam for assistant markdown, and rewriting React-owned DOM would break re-renders. Tokens are therefore styled with the CSS Custom Highlight API (red wavy for unknown IDs), and clicks and hovers are resolved by hit-testing the caret position.

## Model Experience

### Reference tokens the viewer inserts into user messages

#### What the model sees

Indirectly, through user text. "Reference in chat" and the `@` source insert `[[<element id>|r<rev>]]` into the user's message, and `@pulseos/seq-refs` adds the context for each token. The viewer itself sends nothing to the model.

#### Token effect

Indirectly, through user text: one short token per inserted reference, plus the context that `@pulseos/seq-refs` adds for it.

#### KV Cache effect

Indirectly, through user text, which is appended to the conversation.

## Known Limitations and Deferred Work

Deferred to M5:
- **Compare mode** (overlay and stacked) and the inspector's change list across arbitrary revisions. Today Changes compares with the parent revision only.
- **Revision cards in chat** at the end of a turn.
- **Restore from the revision picker.** Restore today goes through chat (`seq_restore`).

Not yet built:
- **Narrow-screen layouts** — below 900 px only the recipe pane is hidden; the tab and bottom-sheet layouts are not built.
- **Measure tool, phase-encode ladder overlay, URL-hash view state, drag-to-composer and `[[` autocomplete.** The `@` source replaces `[[`, because DSH trigger characters are only `/` and `@`.
- **Property source tags** (param, derived, code) in the inspector.
- **Resizable inspector and per-track scale toggle** — fixed height and a shared gradient scale only.
- **Envelope decimation** — events narrower than 2 px are drawn as peak bars, not min/max envelopes; large sequences have not been profiled for 60 fps.
- **Theme tokens** — the viewer follows DSH's light/dark scheme but keeps its own palette per scheme; DSH token overrides (`--dsw-*`) from a custom theme do not recolor the waveforms.

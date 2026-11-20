# @pulseos/seq-refs

Turns `[[<element id>]]` references in user messages into context the model can use. When a user writes `Why is [[gre2d:excitation.rf|r1]] different from [[gre2d:excitation.rf]]?`, the next model step receives the message unchanged, followed by one context message that describes each referenced element.

## Behavior

- The plugin listens on the `agent/pre-step` waterfall with `prepend`. It reads only direct user messages (`source.kind === 'user'`), and only their text blocks.
- Tokens come from `findReferences` in `@pulseos/seq-protocol`: `[[id]]` points at the latest revision and `[[id|rN]]` pins revision N. Duplicate tokens are expanded once.
- For each token the context says one of the following:
  - The element's description at that revision. This uses the same text as `seq_get_element`: timing, amplitudes, variation across instances, timing errors and the recipe lines that emit it.
  - For a pinned older revision, also whether the element is unchanged, changed, renamed or gone at the latest revision.
  - That it does not exist, with the reason.
  - That it is unresolved: a malformed ID, no such revision, or nothing built yet.
- The context message has source kind `pulseos-reference`, form `notice`, a one-line summary and the outcome of each reference. The agent loop logs it as a durable `user/message`, so the model's input can be rebuilt from the session log; `apps/pulseos/tests/references.spec.ts` checks this byte for byte.
- References inside assistant text are not expanded here. The viewer (M4) renders them as chips and flags unknown IDs.

## Config

| Key | Default | Meaning |
|---|---|---|
| `maxReferences` | `8` | References expanded per message; the rest are listed as not expanded. |
| `maxCharsPerReference` | `2000` | Longest description of one element, in characters. |

## Model Experience

### Reference context after a user message that contains `[[...]]`

#### What the model sees

Right after the user's message comes one user-role message. Its text starts with the fixed lines below, followed by one block per reference:

##### Verbatim header

```markdown
<sequence-references>

The user's message refers to these pulse sequence elements; each [[...]] token in the message means the element described here.
```

Each block starts with the token as the user wrote it, then the revision (`— at r2 (latest):`), then the element description. A block for a pinned older revision ends with a line comparing the element against the latest revision. The message ends with `</sequence-references>`.

#### Token effect

Only messages that contain reference tokens add anything. Each referenced element adds up to `maxCharsPerReference` characters (about 500 tokens at the default), and at most `maxReferences` elements are expanded per message.

#### KV Cache effect

The context message is appended after the user message it explains. It never changes earlier request tokens, so the cached prefix stays valid.

## Known Limitations and Deferred Work

- **Assistant references are not checked on the host** — an invented ID in model output is flagged only by the viewer's unresolved chip.

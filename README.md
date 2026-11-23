# PulseOS

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/pulseos-logo-dark.svg">
    <img alt="PulseOS" src="assets/logo/pulseos-logo-light.svg" width="420">
  </picture>
</p>

A platform for MR pulse sequence development with an LLM in the loop. It is built from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugins: a slim chat panel on the left, an interactive sequence viewer on the right, and a [pypulseq](https://github.com/imr-framework/pypulseq) backend. Every sequence element has a stable ID, so it can be referenced in chat and changed from there.

The plan and milestones are tracked in POS-4. Milestones land as stacked pull requests; the stack is at **M4: the viewer**: chat on the left, the interactive sequence viewer on the right. The model builds, inspects, edits and compares the 2D GRE; every element can be clicked into chat as `[[gre2d:excitation.rf|r1]]`, and references in chat highlight the element in the viewer.

## Layout

```
dsh/                 DeepSeek Harness, git submodule pinned to one commit
packages/<group>/    PulseOS DSH plugins (pnpm workspace)
  seq/scanner-profile  ctx.scannerProfile: swappable scanner limits
  seq/protocol         shared types: element IDs, sequence model, revision records, [[id]] tokens
  seq/service          ctx.pulseSeq: confined builds, session revisions, model store
  seq/tools            seq_* model tools (status, build, set params, edit recipe, diff, ...)
  seq/refs             [[element id]] references in user messages -> logged model context
  seq/viewer           Web client: right-sidebar waveform viewer, inspector, reference chips
  app/brand            Web client: PulseOS mark, wordmark and hero banner in DSH's brand slots
apps/pulseos/        cordis.patch.yml: the PulseOS overlay on a DSH profile
profiles/scanner/    scanner profile JSON files, shared by TypeScript and Python
python/              pulseos_seq: recipes, SeqBuilder, element IDs, model JSON, build runner
scripts/             bootstrap, DSH launcher and its model selection, boot smoke
```

## Requirements

- Node.js >= 24.9 and pnpm 11 (`corepack enable` picks the pinned version)
- [uv](https://docs.astral.sh/uv/)
- git

## Setup

```sh
git clone --recurse-submodules https://github.com/mikecjz/pulseos.git
cd pulseos
pnpm run bootstrap
```

`bootstrap` checks out the DSH submodule, installs and builds it (`build:artifacts`, a few minutes), installs this workspace, builds the viewer bundle and creates the Python environment. Run it again after moving the DSH pin; after editing `packages/seq/viewer/src/client` or `packages/app/brand/src/client`, run `pnpm run build`.

## Run

```sh
pnpm run web               # DSH Web UI with the PulseOS overlay
pnpm run dsh <profile> ... # any DSH profile with the overlay, e.g. `pnpm run dsh headless "task"`
```

In the Web UI, the sequence viewer opens on the right as soon as a session exists, showing "No sequence built yet" until something is built. Ask the model to build the sequence (for example "Build the 2D GRE"), or click "Build gre2d with defaults". If you close the viewer it stays closed for that session; reopen it from the right sidebar's "+" as "Sequence viewer". Click an element to inspect it, press `R` or "Reference in chat" to put it into your message, or type `@` and pick from "Sequence". Without a model key, the viewer's empty state can still build the default recipe.

The launcher runs the DSH CLI from `dsh/` source and passes `apps/pulseos/cordis.patch.yml` as `--patch`. `DSH_HOME` defaults to `.dsh-home/` in this checkout, so development profiles and credentials stay out of `~/.dsh`; export `DSH_HOME` to override. With the default model, a model call needs `DEEPSEEK_API_KEY` or a key saved on the Web Models page.

## Models

DeepSeek is the default. Other providers go through DSH's pi-ai adapter (`llm-pi-ai`, part of every DSH profile), which speaks OpenAI-compatible Chat Completions and Anthropic's native Messages API. There are two ways to use another provider:

- **Web Models page.** In `pnpm run web`, open Models, add a provider (OpenRouter, OpenAI, Anthropic, Moonshot/Kimi, Z.ai/GLM, a custom OpenAI-compatible endpoint, ...) with its key, and pick its model in the chat's model selector.
- **`PULSEOS_MODEL=<route>/<model id>`** for any profile, including `headless`. The launcher adds one more patch layer (`$DSH_HOME/pulseos-model.patch.yml`) that declares the route and makes the model the default for new sessions.

```sh
ANTHROPIC_API_KEY=... PULSEOS_MODEL=anthropic/claude-sonnet-5-5 pnpm run web
ZAI_API_KEY=... PULSEOS_MODEL=zai/glm-5.3 pnpm run dsh headless "Build the 2D GRE"
OPENROUTER_API_KEY=... PULSEOS_MODEL=openrouter/moonshotai/kimi-k3 pnpm run web
PULSEOS_LLM_BASE_URL=http://localhost:8000/v1 PULSEOS_LLM_API_KEY=local PULSEOS_MODEL=local/qwen3-32b pnpm run web
```

| Route | Provider | Protocol | Key |
|---|---|---|---|
| `deepseek-official` | DeepSeek, native DSH adapter (default) | Anthropic-compatible | `DEEPSEEK_API_KEY` |
| `openai` | OpenAI | Responses | `OPENAI_API_KEY` |
| `anthropic` | Anthropic Claude | Messages | `ANTHROPIC_API_KEY` |
| `openrouter` | OpenRouter (model ids keep their `vendor/` prefix) | per model, mostly Chat Completions | `OPENROUTER_API_KEY` |
| `moonshotai`, `moonshotai-cn` | Moonshot Kimi | Chat Completions | `MOONSHOT_API_KEY` |
| `zai` | Z.ai GLM | Chat Completions | `ZAI_API_KEY` |
| `deepseek` | DeepSeek through pi-ai | Chat Completions | `DEEPSEEK_API_KEY` |
| any other lowercase name | custom endpoint; needs `PULSEOS_LLM_BASE_URL` | `PULSEOS_LLM_API`: `openai-completions` (default), `openai-responses` or `anthropic-messages` | `PULSEOS_LLM_API_KEY` |

A model id the installed pi-ai catalog does not list still works on a single-protocol route; on OpenRouter it also needs `PULSEOS_LLM_API` (usually `openai-completions`). `PULSEOS_LLM_BASE_URL` also overrides the endpoint of a listed route, for example a corporate proxy. Keys resolve per request from the environment, a project or user `.env`, or the DSH credential store; a missing key fails the request with `MISSING_CREDENTIAL`. A malformed selection stops the launcher before DSH starts.

While `PULSEOS_MODEL` is set, the launcher's patch wins over Models-page edits to the pi-ai providers and to the default model, because DSH refuses form writes that a command-line patch overrides. Unset it to manage providers from the Models page again.

## Checks

```sh
pnpm run typecheck     # tsc -b; DSH vendor packages are referenced projects
pnpm run lint          # oxlint
pnpm run test          # vitest: units, headless and browser composition tests (scripted keyless model)
pnpm run smoke:boot    # keyless: boots `dsh web` with the overlay
pnpm run build         # viewer client bundle (needed by `web` and the browser test)
pnpm run test:python   # pytest, python/
```

## How PulseOS uses DSH

- DSH is not forked. PulseOS code lives in this repository's packages and is added to a DSH profile by the overlay in `apps/pulseos/`.
- PulseOS sources import `@deepseek-ai/*` packages by name. `tsconfig.base.json` extends the DSH base config, whose `paths` resolve those names to `dsh/` source; vitest and the tsx loader in the DSH CLI use the same mapping.
- To move the pin: `git -C dsh fetch --depth 1 origin <sha> && git -C dsh checkout <sha>`, run `pnpm run bootstrap`, run the checks, and commit the submodule change on its own.

## Scanner profiles

Scanner limits live in `profiles/scanner/<id>.json`. The default is `generic` (3 T, 40 mT/m, 150 T/m/s). See [profiles/scanner/README.md](profiles/scanner/README.md) for fields and how to select another scanner.

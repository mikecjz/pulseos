# PulseOS

A platform for MR pulse sequence development with an LLM in the loop. It is built from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugins: a slim chat panel on the left, an interactive sequence viewer on the right, and a [pypulseq](https://github.com/imr-framework/pypulseq) backend. Every sequence element has a stable ID, so it can be referenced in chat and changed from there.

The plan and milestones are tracked in POS-4. This repository is at **M0: scaffold**.

## Layout

```
dsh/                 DeepSeek Harness, git submodule pinned to one commit
packages/<group>/    PulseOS DSH plugins (pnpm workspace)
  seq/scanner-profile  ctx.scannerProfile: swappable scanner limits
apps/pulseos/        cordis.patch.yml: the PulseOS overlay on a DSH profile
profiles/scanner/    scanner profile JSON files, shared by TypeScript and Python
python/              pulseos_seq: pypulseq backend (uv project, Python >= 3.11)
scripts/             bootstrap, DSH launcher, boot smoke
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

`bootstrap` checks out the DSH submodule, installs and builds it (`build:artifacts`, a few minutes), installs this workspace and creates the Python environment. Run it again after moving the DSH pin.

## Run

```sh
pnpm run web               # DSH Web UI with the PulseOS overlay
pnpm run dsh <profile> ... # any DSH profile with the overlay, e.g. `pnpm run dsh headless "task"`
```

The launcher runs the DSH CLI from `dsh/` source and passes `apps/pulseos/cordis.patch.yml` as `--patch`. `DSH_HOME` defaults to `.dsh-home/` in this checkout, so development profiles and credentials stay out of `~/.dsh`; export `DSH_HOME` to override. A model call needs `DEEPSEEK_API_KEY` or a key saved on the Web Models page.

## Checks

```sh
pnpm run typecheck     # tsc -b; DSH vendor packages are referenced projects
pnpm run lint          # oxlint
pnpm run test          # vitest, PulseOS packages
pnpm run smoke:boot    # keyless: boots `dsh web` with the overlay
pnpm run test:python   # pytest, python/
```

## How PulseOS uses DSH

- DSH is not forked. PulseOS code lives in this repository's packages and is added to a DSH profile by the overlay in `apps/pulseos/`.
- PulseOS sources import `@deepseek-ai/*` packages by name. `tsconfig.base.json` extends the DSH base config, whose `paths` resolve those names to `dsh/` source; vitest and the tsx loader in the DSH CLI use the same mapping.
- To move the pin: `git -C dsh fetch --depth 1 origin <sha> && git -C dsh checkout <sha>`, run `pnpm run bootstrap`, run the checks, and commit the submodule change on its own.

## Scanner profiles

Scanner limits live in `profiles/scanner/<id>.json`. The default is `generic` (3 T, 40 mT/m, 150 T/m/s). See [profiles/scanner/README.md](profiles/scanner/README.md) for fields and how to select another scanner.

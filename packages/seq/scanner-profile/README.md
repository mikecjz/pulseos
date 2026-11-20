# @pulseos/scanner-profile

Loads one scanner profile, the hardware limits and raster times that sequences are built against, and exposes it as `ctx.scannerProfile`. Profiles are JSON files described in [`profiles/scanner/README.md`](../../../profiles/scanner/README.md). The Python backend reads the same files through `pulseos_seq.scanner`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `profile` | `generic` | Profile id: the file name without `.json`. |
| `directory` | `profiles/scanner` in this repository | Directory holding the profile files. |

Swap the scanner in a cordis patch:

```yaml
- id: pulseos-scanner-profile
  config:
    profile: prisma
    directory: /etc/pulseos/scanners
```

The profile is read once when the plugin loads. A missing file, an `id` that does not match the file name, an unknown or missing field, or a value out of range fails the plugin load with the file path in the message. Changing the config reloads the plugin and therefore re-reads the file.

## Service

- `ctx.scannerProfile.profile` — the loaded `ScannerProfile` (`id`, `title`, optional `description`, `limits`).
- `ctx.scannerProfile.limits()` — a copy of the `ScannerLimits`.
- `loadScannerProfile(directory, id)` — the same validation without a plugin, for tests and tools.

## Model Experience

### No model-visible surface

#### What the model sees

None. This package registers no tool, prompt text or context injection; the sequence tools added in M2 will report the active limits through their own results.

#### Token effect

None.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- **No live file reload** — editing a profile file does not take effect until the plugin reloads (config change or restart).
- **Generic profile only** — vendor or site profiles are added as new JSON files when a target scanner is chosen.

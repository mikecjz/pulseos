## Scanner profiles

A scanner profile is one JSON file in this directory: `<id>.json`. It holds the hardware limits and raster times that every sequence is built against. The TypeScript plugin `@pulseos/scanner-profile` and the Python backend `pulseos_seq.scanner` read the same file, so both sides always agree on the limits.

To target a different scanner, add a new file (for example `prisma.json`) and select it:

- in DSH, set `profile: prisma` on the `pulseos-scanner-profile` row of a cordis patch;
- in Python, call `pulseos_seq.scanner.load_profile("prisma")`.

`directory` (DSH config) or the `directory` argument (Python) points at another profile directory, so site-specific profiles can live outside this repository.

### Fields

Every field is required. Units are part of the key name.

| Key | Unit | pypulseq `Opts` argument |
|---|---|---|
| `b0_T` | T | `B0` |
| `max_grad_mT_per_m` | mT/m | `max_grad` (`grad_unit="mT/m"`) |
| `max_slew_T_per_m_per_s` | T/m/s | `max_slew` (`slew_unit="T/m/s"`) |
| `grad_raster_time_s` | s | `grad_raster_time` |
| `rf_raster_time_s` | s | `rf_raster_time` |
| `adc_raster_time_s` | s | `adc_raster_time` |
| `block_duration_raster_s` | s | `block_duration_raster` |
| `rf_dead_time_s` | s | `rf_dead_time` |
| `rf_ringdown_time_s` | s | `rf_ringdown_time` |
| `adc_dead_time_s` | s | `adc_dead_time` |

`id` must equal the file name without `.json`. Both loaders reject a missing field, an unknown field, a non-positive value (dead and ringdown times may be zero) or an `id` mismatch.

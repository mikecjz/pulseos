## seq_status
No sequence has been built in this session yet. Call seq_build to build the default 2D GRE recipe.

## seq_build
Built r1 (init, model): initial 2D GRE build; timing OK. Duration 640 ms, 320 blocks.
Timing check: OK (pypulseq check_timing found no errors).

## seq_status
Sequence gre2d at r1 of 1 (r1 (init, model): initial 2D GRE build; timing OK).
Scanner profile generic; total duration 640 ms; 320 blocks; loops: slice x1, line x64.
Parameters (set them in SI units, e.g. seconds and metres):
  gre2d:param.FOV: FOV = 256 mm (0.256 m) — In-plane field of view
  gre2d:param.Nx: Nx = 64 — Readout matrix size
  gre2d:param.Ny: Ny = 64 — Phase-encode matrix size
  gre2d:param.slice_thickness: slice_thickness = 3 mm (0.003 m) — Slice thickness
  gre2d:param.n_slices: n_slices = 1 — Number of slices
  gre2d:param.slice_gap: slice_gap = 0 mm (0 m) — Gap between adjacent slices
  gre2d:param.flip_angle: flip_angle = 15 deg — Excitation flip angle
  gre2d:param.TE: TE = 4.2 ms (0.0042 s) — Echo time (excitation centre to echo centre)
  gre2d:param.TR: TR = 10 ms (0.01 s) — Repetition time
  gre2d:param.rf_duration: rf_duration = 1 ms (0.001 s) — Excitation sinc pulse duration
  gre2d:param.rf_tbw: rf_tbw = 4 — Excitation pulse time-bandwidth product
  gre2d:param.readout_duration: readout_duration = 3.2 ms (0.0032 s) — ADC (flat top) duration
  gre2d:param.rf_spoiling_inc: rf_spoiling_inc = 117 deg — RF spoiling phase increment
Roles in time order within one repetition:
  gre2d:excitation x64 (recipe line 81): gre2d:excitation.rf [rf], gre2d:excitation.gz [gz]
  gre2d:prephase x64 (recipe line 83): gre2d:prephase.gx [gx], gre2d:prephase.gy [gy], gre2d:prephase.gz [gz]
  gre2d:te_fill x64 (recipe line 84): delay only
  gre2d:readout x64 (recipe line 86): gre2d:readout.gx [gx], gre2d:readout.adc [adc]
  gre2d:spoil x64 (recipe line 88): gre2d:spoil.gx [gx], gre2d:spoil.gy [gy], gre2d:spoil.gz [gz]
Markers: gre2d:param.TE 710 us -> 4.91 ms; gre2d:param.TR 0 ms -> 10 ms.
Timing check: OK.
Instance IDs append loop indices, e.g. <role>.<event>@slice=0,line=12.

## seq_get_element
At r1:
Event gre2d:excitation.rf on channel rf: 64 instance(s).
First instance (gre2d:excitation.rf@slice=0,line=0): starts 210 us (delay 210 us in its block), duration 1 ms, flip angle 15 deg, peak 3.865 uT, phase offset 0 rad, frequency offset 0 Hz.
Across instances: phaseOffset varies from 0 to 6.126.
Emitted by recipe lines 81-81:
81 |             b.block("excitation", rf=rf, gz=gz)

## seq_set_params
Built r2 (param, model): TE 5 ms, flip 25 deg; timing OK. Duration 640 ms, 320 blocks.
Parameter changes: gre2d:param.flip_angle 15 -> 25 deg, gre2d:param.TE 0.0042 -> 0.005 s.
Roles: gre2d:excitation changed, gre2d:te_fill changed, gre2d:spoil changed.
Timing check: OK (pypulseq check_timing found no errors).

## seq_set_params (error)
Error: Build failed (runtime, recipe line 62): ValueError: TE = 1.00 ms is too short; the minimum for these settings is 3.08 ms. The current revision is unchanged.

## seq_check_timing
At r2: Timing check: OK (pypulseq check_timing found no errors).

## seq_edit_recipe
Built r3 (code, model): rename excitation role; timing OK. Duration 640 ms, 320 blocks.
Roles: renamed excitation->rf_excite.
Timing check: OK (pypulseq check_timing found no errors).

## seq_edit_recipe (error)
Error: Build failed (check, recipe line 4): import of "os" is not allowed; allowed: math, numpy, pulseos_seq, pypulseq. The current revision is unchanged.

## seq_get_element
At r2:
Event gre2d:excitation.rf on channel rf: 64 instance(s).
First instance (gre2d:excitation.rf@slice=0,line=0): starts 210 us (delay 210 us in its block), duration 1 ms, flip angle 25 deg, peak 6.442 uT, phase offset 0 rad, frequency offset 0 Hz.
Across instances: phaseOffset varies from 0 to 6.126.
Emitted by recipe lines 81-81:
81 |             b.block("excitation", rf=rf, gz=gz)

## seq_diff
r2 -> r3
Parameters: unchanged
Roles changed: none; added: none; removed: none; renamed: excitation->rf_excite
Recipe diff:
Index: recipe.py
===================================================================
--- recipe.py	r2
+++ recipe.py	r3
@@ -77,9 +77,9 @@
             rf_inc = (rf_inc + p.rf_spoiling_inc) % 360.0
             rf_phase = (rf_phase + rf_inc) % 360.0
 
             tr_start = b.now()
-            b.block("excitation", rf=rf, gz=gz)
+            b.block("rf_excite", formerly="excitation", rf=rf, gz=gz)
             gy_pre = pp.make_trapezoid(channel="y", area=phase_areas[line], duration=prephase_time, system=system)
             b.block("prephase", gx=gx_pre, gy=gy_pre, gz=gz_reph)
             b.block("te_fill", delay=pp.make_delay(te_fill))
             readout_start = b.now()

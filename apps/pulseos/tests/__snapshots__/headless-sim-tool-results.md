## sim_run (error)
Error: no sequence has been built in this session yet.

## seq_build
Built r1 (init, model): initial 2D GRE build; timing OK. Duration 640 ms, 320 blocks.
Timing check: OK (pypulseq check_timing found no errors).

## sim_summary (error)
Error: No simulation has run in this session yet. Call sim_run.

## sim_run
Simulation [[sim:r1/tubes]]: r1 (gre2d) on phantom tubes with fake 1, cpu, 64 ms.
Acquisition: 64 x 64 samples, FOV 200 x 200 mm; 64 repetitions simulated on a 64^2 grid.
Sequence at r1: TE 4.2 ms, TR 10 ms, flip_angle 15 deg, Ny 64, Nx 64.
Signal: peak 326; k-space centre line is ADC 32 (acquisition order), its peak 326.
Image magnitude: max 0.941, mean 0.1, no noise added.
Mean signal per tissue (brightest first, relative to the brightest): a 0.671 (1), b 0.437 (0.65), e 0.37 (0.55), d 0.321 (0.48), c 0.253 (0.38), f 0.111 (0.16).
Largest contrast: a/f = 6.07.

## seq_set_params
Built r2 (param, model): flip 15 -> 30 deg; timing OK. Duration 640 ms, 320 blocks.
Parameter changes: gre2d:param.flip_angle 15 -> 30 deg.
Roles: gre2d:excitation changed.
Timing check: OK (pypulseq check_timing found no errors).

## sim_run
Simulation [[sim:r2/tubes]]: r2 (gre2d) on phantom tubes with fake 1, cpu, 64 ms.
Acquisition: 64 x 64 samples, FOV 200 x 200 mm; 64 repetitions simulated on a 64^2 grid.
Sequence at r2: TE 4.2 ms, TR 10 ms, flip_angle 30 deg, Ny 64, Nx 64.
Signal: peak 445; k-space centre line is ADC 32 (acquisition order), its peak 445.
Image magnitude: max 1.29, mean 0.1, no noise added.
Mean signal per tissue (brightest first, relative to the brightest): a 0.918 (1), b 0.598 (0.65), e 0.506 (0.55), d 0.439 (0.48), c 0.345 (0.38), f 0.151 (0.16).
Largest contrast: a/f = 6.07.
Compared with r1 on the same phantom: a 0.671 -> 0.918 (+37%), b 0.437 -> 0.598 (+37%), e 0.37 -> 0.506 (+37%), d 0.321 -> 0.439 (+37%), c 0.253 -> 0.345 (+37%), f 0.111 -> 0.151 (+37%).

## sim_run
Simulation [[sim:r1/tubes]]: r1 (gre2d) on phantom tubes with fake 1, cpu, from cache.
Acquisition: 64 x 64 samples, FOV 200 x 200 mm; 64 repetitions simulated on a 64^2 grid.
Sequence at r1: TE 4.2 ms, TR 10 ms, flip_angle 15 deg, Ny 64, Nx 64.
Signal: peak 326; k-space centre line is ADC 32 (acquisition order), its peak 326.
Image magnitude: max 0.941, mean 0.1, no noise added.
Mean signal per tissue (brightest first, relative to the brightest): a 0.671 (1), b 0.437 (0.65), e 0.37 (0.55), d 0.321 (0.48), c 0.253 (0.38), f 0.111 (0.16).
Largest contrast: a/f = 6.07.
Compared with r2 on the same phantom: a 0.918 -> 0.671 (-27%), b 0.598 -> 0.437 (-27%), e 0.506 -> 0.37 (-27%), d 0.439 -> 0.321 (-27%), c 0.345 -> 0.253 (-27%), f 0.151 -> 0.111 (-27%).

## sim_run (error)
Error: Simulation failed (input): the fake engine has no phantom "nope"; phantoms: tubes, brainweb-axial, broken

## sim_summary
Simulation [[sim:r2/tubes]]: r2 (gre2d) on phantom tubes with fake 1, cpu, 64 ms.
Acquisition: 64 x 64 samples, FOV 200 x 200 mm; 64 repetitions simulated on a 64^2 grid.
Sequence at r2: TE 4.2 ms, TR 10 ms, flip_angle 30 deg, Ny 64, Nx 64.
Signal: peak 445; k-space centre line is ADC 32 (acquisition order), its peak 445.
Image magnitude: max 1.29, mean 0.1, no noise added.
Mean signal per tissue (brightest first, relative to the brightest): a 0.918 (1), b 0.598 (0.65), e 0.506 (0.55), d 0.439 (0.48), c 0.345 (0.38), f 0.151 (0.16).
Largest contrast: a/f = 6.07.
Compared with r1 on the same phantom: a 0.671 -> 0.918 (+37%), b 0.437 -> 0.598 (+37%), e 0.37 -> 0.506 (+37%), d 0.321 -> 0.439 (+37%), c 0.253 -> 0.345 (+37%), f 0.111 -> 0.151 (+37%).
The latest simulation attempt (r2, nope) failed: the fake engine has no phantom "nope"; phantoms: tubes, brainweb-axial, broken
"""2D spoiled gradient echo (FLASH), Cartesian, sequential phase encoding, RF spoiling."""

import math

import numpy as np
import pypulseq as pp

from pulseos_seq import param

SEQUENCE = "gre2d"

PARAMS = {
    "FOV": param(256e-3, "m", "In-plane field of view", min=10e-3, max=600e-3),
    "Nx": param(64, "", "Readout matrix size", min=8, max=1024, integer=True),
    "Ny": param(64, "", "Phase-encode matrix size", min=1, max=1024, integer=True),
    "slice_thickness": param(3e-3, "m", "Slice thickness", min=0.2e-3, max=50e-3),
    "n_slices": param(1, "", "Number of slices", min=1, max=64, integer=True),
    "slice_gap": param(0.0, "m", "Gap between adjacent slices", min=0.0, max=50e-3),
    "flip_angle": param(15.0, "deg", "Excitation flip angle", min=0.1, max=90.0),
    "TE": param(4.2e-3, "s", "Echo time (excitation centre to echo centre)", min=0.5e-3, max=100e-3),
    "TR": param(10e-3, "s", "Repetition time", min=2e-3, max=5.0),
    "rf_duration": param(1e-3, "s", "Excitation sinc pulse duration", min=0.2e-3, max=10e-3),
    "rf_tbw": param(4.0, "", "Excitation pulse time-bandwidth product", min=1.0, max=20.0),
    "readout_duration": param(3.2e-3, "s", "ADC (flat top) duration", min=0.32e-3, max=20e-3),
    "rf_spoiling_inc": param(117.0, "deg", "RF spoiling phase increment", min=0.0, max=360.0),
}


def ceil_to(value, raster):
    return math.ceil(round(value / raster, 6)) * raster


def build(b, p):
    system = b.system
    raster = system.grad_raster_time

    rf, gz, _ = pp.make_sinc_pulse(
        flip_angle=math.radians(p.flip_angle), duration=p.rf_duration, slice_thickness=p.slice_thickness,
        apodization=0.5, time_bw_product=p.rf_tbw, system=system, return_gz=True, use="excitation",
        delay=system.rf_dead_time,
    )
    delta_k = 1 / p.FOV
    gx = pp.make_trapezoid(channel="x", flat_area=p.Nx * delta_k, flat_time=p.readout_duration, system=system)
    adc = pp.make_adc(num_samples=p.Nx, duration=gx.flat_time, delay=gx.rise_time, system=system)
    gx_pre = pp.make_trapezoid(channel="x", area=-gx.area / 2, system=system)
    gz_reph = pp.make_trapezoid(channel="z", area=-gz.area / 2, system=system)
    prephase_time = max(pp.calc_duration(gx_pre), pp.calc_duration(gz_reph),
                        pp.calc_duration(pp.make_trapezoid(channel="y", area=p.Ny / 2 * delta_k, system=system)))
    gx_pre = pp.make_trapezoid(channel="x", area=-gx.area / 2, duration=prephase_time, system=system)
    gz_reph = pp.make_trapezoid(channel="z", area=-gz.area / 2, duration=prephase_time, system=system)
    phase_areas = (np.arange(p.Ny) - p.Ny / 2) * delta_k

    gx_spoil = pp.make_trapezoid(channel="x", area=2 * p.Nx * delta_k, system=system)
    gz_spoil = pp.make_trapezoid(channel="z", area=4 / p.slice_thickness, system=system)

    excitation_duration = pp.calc_duration(rf, gz)
    rf_centre = rf.delay + pp.calc_rf_center(rf)[0]
    echo_from_readout_start = gx.rise_time + gx.flat_time / 2
    te_fill = ceil_to(p.TE - (excitation_duration - rf_centre) - prephase_time - echo_from_readout_start, raster)
    if te_fill < 0:
        minimum = p.TE - te_fill
        raise ValueError(f"TE = {p.TE * 1e3:.2f} ms is too short; the minimum for these settings is {minimum * 1e3:.2f} ms")
    spoil_time = pp.calc_duration(gx_spoil, gz_spoil, pp.make_trapezoid(channel="y", area=p.Ny / 2 * delta_k, duration=prephase_time, system=system))
    tr_fill = ceil_to(p.TR - excitation_duration - prephase_time - te_fill - pp.calc_duration(gx, adc), raster)
    if tr_fill < spoil_time:
        minimum = p.TR - tr_fill + spoil_time
        raise ValueError(f"TR = {p.TR * 1e3:.2f} ms is too short; the minimum for these settings is {minimum * 1e3:.2f} ms")

    slice_pitch = p.slice_thickness + p.slice_gap
    rf_phase = 0.0
    rf_inc = 0.0
    for s in b.loop("slice", range(p.n_slices)):
        rf.freq_offset = gz.amplitude * slice_pitch * (s - (p.n_slices - 1) / 2)
        for line in b.loop("line", range(p.Ny)):
            rf.phase_offset = math.radians(rf_phase)
            adc.phase_offset = math.radians(rf_phase)
            rf_inc = (rf_inc + p.rf_spoiling_inc) % 360.0
            rf_phase = (rf_phase + rf_inc) % 360.0

            tr_start = b.now()
            b.block("excitation", rf=rf, gz=gz)
            gy_pre = pp.make_trapezoid(channel="y", area=phase_areas[line], duration=prephase_time, system=system)
            b.block("prephase", gx=gx_pre, gy=gy_pre, gz=gz_reph)
            b.block("te_fill", delay=pp.make_delay(te_fill))
            readout_start = b.now()
            b.block("readout", gx=gx, adc=adc)
            gy_rewind = pp.make_trapezoid(channel="y", area=-phase_areas[line], duration=prephase_time, system=system)
            b.block("spoil", gx=gx_spoil, gy=gy_rewind, gz=gz_spoil, delay=pp.make_delay(tr_fill))
            if s == 0 and line == 0:
                b.mark("TE", readout_start + echo_from_readout_start, start=tr_start + rf_centre)
                b.mark("TR", tr_start + p.TR, start=tr_start)

"""Self-confinement (Landlock on Linux, Seatbelt on macOS): reads, writes and TCP are restricted after confine()."""

import json
import subprocess
import sys
import textwrap

import pytest

from pulseos_seq.confine import MINIMUM_ABI, available

# macOS always has Seatbelt, so a broken backend there fails these tests instead of skipping them.
pytestmark = pytest.mark.skipif(sys.platform != "darwin" and not available(),
                                reason="needs Linux Landlock ABI >= 4 or macOS Seatbelt")

PROBE = textwrap.dedent("""
    import json, os, socket, sys
    from pulseos_seq.confine import confine
    writable, outside = sys.argv[1], sys.argv[2]
    confine(writable)
    results = {}
    def attempt(name, fn):
        try:
            fn(); results[name] = "allowed"
        except OSError as error:
            results[name] = "denied"
    attempt("write_inside", lambda: open(os.path.join(writable, "ok.txt"), "w").write("x"))
    attempt("write_outside", lambda: open(os.path.join(outside, "no.txt"), "w").write("x"))
    attempt("read_outside", lambda: open(os.path.join(outside, "secret.txt")).read())
    attempt("read_etc", lambda: open("/etc/hosts").read())
    def connect():
        s = socket.socket(); s.settimeout(2); s.connect(("127.0.0.1", 9))
    attempt("tcp_connect", connect)
    import numpy, pypulseq  # already-installed packages stay importable
    results["import"] = "allowed"
    print(json.dumps(results))
""")


def test_confinement_restricts_files_and_network(tmp_path):
    writable, outside = tmp_path / "work", tmp_path / "outside"
    writable.mkdir(); outside.mkdir()
    (outside / "secret.txt").write_text("secret")
    done = subprocess.run([sys.executable, "-c", PROBE, str(writable), str(outside)],
                          capture_output=True, text=True, check=True)
    results = json.loads(done.stdout)
    assert results == {"write_inside": "allowed", "write_outside": "denied", "read_outside": "denied",
                       "read_etc": "denied", "tcp_connect": "denied", "import": "allowed"}


def test_confined_build_through_the_runner(tmp_path):
    request = {"recipe": {"bundled": "gre2d"}, "params": {"Ny": 8}, "seqPath": str(tmp_path / "out.seq"),
               "confine": {"writable": str(tmp_path)}}
    done = subprocess.run([sys.executable, "-m", "pulseos_seq.run"], input=json.dumps(request),
                          capture_output=True, text=True, check=True)
    result = json.loads(done.stdout)
    assert result["ok"], result.get("error")
    confinement = result["model"]["confinement"]
    if sys.platform == "darwin":
        assert confinement == {"mechanism": "seatbelt"}
    else:
        assert confinement["mechanism"] == "landlock" and confinement["landlockAbi"] >= MINIMUM_ABI
    assert (tmp_path / "out.seq").is_file()


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS only")
def test_seatbelt_blocks_spawning_and_udp(tmp_path):
    probe = textwrap.dedent("""
        import json, socket, subprocess, sys
        from pulseos_seq.confine import confine
        confine(sys.argv[1])
        results = {}
        try:
            subprocess.run(["/bin/echo", "x"], check=True, capture_output=True); results["spawn"] = "allowed"
        except OSError:
            results["spawn"] = "denied"
        try:
            socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"x", ("127.0.0.1", 9)); results["udp"] = "allowed"
        except OSError:
            results["udp"] = "denied"
        print(json.dumps(results))
    """)
    done = subprocess.run([sys.executable, "-c", probe, str(tmp_path)], capture_output=True, text=True, check=True)
    assert json.loads(done.stdout) == {"spawn": "denied", "udp": "denied"}

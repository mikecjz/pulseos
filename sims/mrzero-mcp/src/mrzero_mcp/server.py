"""MCP server (stdio) implementing the PulseOS simulation tool contract ``pulseos.sim/1`` with MRzero.

Tools: ``engine_info``, ``list_phantoms``, ``simulate``. ``simulate`` writes its arrays to
``<out>/<resultKey>/`` and returns only metadata; it reports ``notifications/progress`` once per
sequence repetition when the caller passes a progress token, and stops between repetitions when
the caller cancels.

Configuration (flags or environment): ``--out``/``MRZERO_OUT`` result directory,
``--phantoms``/``MRZERO_PHANTOMS`` phantom directory, ``--device``/``MRZERO_DEVICE``
(``auto``, ``cpu``, ``cuda`` or ``cuda:N``).

stdout carries the MCP stream only: at startup the original stdout descriptor is kept for MCP and
descriptor 1 is pointed at stderr, so prints from MRzero (Python or Rust) cannot corrupt it.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import threading
import time
from importlib.metadata import version
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from mcp.server.fastmcp.exceptions import ToolError

PROTOCOL = "pulseos.sim/1"
KEY_RE = re.compile(r"^[0-9a-f]{64}$")


def _isolate_stdout() -> int:
    """Return a private descriptor for the MCP stream and redirect fd 1 (and sys.stdout) to stderr."""
    sys.stdout.flush()
    mcp_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return mcp_fd


def _device(requested: str) -> str:
    import torch

    if requested == "auto":
        return "cuda:0" if torch.cuda.is_available() else "cpu"
    if requested.startswith("cuda"):
        if not torch.cuda.is_available():
            raise SystemExit(f"mrzero-mcp: device {requested} requested but CUDA is not available")
        index = int(requested.split(":", 1)[1]) if ":" in requested else 0
        torch.cuda.set_device(index)
        return f"cuda:{index}"
    if requested != "cpu":
        raise SystemExit(f'mrzero-mcp: unknown device "{requested}"')
    return "cpu"


def build_server(out: Path, phantom_dir: Path, device: str):
    import anyio
    import torch

    from .phantoms import PhantomLibrary
    from .simulate import Cancelled, Settings, SimulationError, simulate, write_result

    library = PhantomLibrary(phantom_dir)
    gpu_lock = threading.Lock()
    mcp = FastMCP("mrzero-mcp", instructions="PulseOS simulation engine (MRzero-Core, PDG). Tool contract pulseos.sim/1.")
    gpu_name = torch.cuda.get_device_name() if device.startswith("cuda") else None

    def info() -> dict[str, Any]:
        return {
            "protocol": PROTOCOL,
            "engine": "mrzero",
            "title": "MRzero (phase distribution graph)",
            "version": version("mrzero-mcp"),
            "engineVersion": version("MRzeroCore"),
            "torchVersion": torch.__version__,
            "device": device,
            "gpu": gpu_name,
            "license": "AGPL-3.0-only",
            "source": "https://github.com/mikecjz/pulseos/tree/main/sims/mrzero-mcp",
        }

    @mcp.tool(description="Engine name, versions, compute device and license.")
    def engine_info() -> dict[str, Any]:
        return info()

    @mcp.tool(description="Phantoms this engine can simulate, with their content hashes.")
    def list_phantoms() -> dict[str, Any]:
        return {"phantoms": [p.info() for p in library.all()]}

    @mcp.tool(name="simulate", description="Simulate a Pulseq .seq file on a phantom. Arrays are written to the result directory under resultKey; the reply carries metadata only.")
    async def simulate_tool(seqText: str, seqHash: str, phantom: str, resultKey: str, ctx: Context,
                            settings: dict[str, Any] | None = None) -> dict[str, Any]:
        if not KEY_RE.match(resultKey):
            raise ToolError("resultKey must be 64 lowercase hex digits")
        try:
            maps = library.get(phantom)
            parsed = Settings.parse(settings)
        except (KeyError, SimulationError) as error:
            raise ToolError(str(error.args[0] if error.args else error)) from error
        assert maps is not None
        cancel = threading.Event()
        last = [0.0]

        def progress(done: int, total: int) -> None:
            if cancel.is_set():
                raise Cancelled()
            now = time.monotonic()
            if done == total or now - last[0] >= 0.1:
                last[0] = now
                try:
                    anyio.from_thread.run(ctx.report_progress, done, total, f"repetition {done}/{total}")
                except Exception:  # noqa: BLE001 - progress is best effort (the call may be gone)
                    pass

        def work():
            with gpu_lock:
                if cancel.is_set():
                    raise Cancelled()
                started = time.perf_counter()
                result = simulate(seqText, maps, parsed, device, progress)
                meta = {"protocol": PROTOCOL, "engine": info(), "phantom": maps.info(), "seqHash": seqHash,
                        "settings": settings or {}, "stats": result.stats, "timing": result.timing,
                        "grid": result.grid, "warnings": result.warnings}
                parts = write_result(out, resultKey, result, meta)
                if device.startswith("cuda"):
                    torch.cuda.empty_cache()
                result.timing["totalMs"] = (time.perf_counter() - started) * 1e3
                return result, parts

        try:
            result, parts = await anyio.to_thread.run_sync(work, abandon_on_cancel=True)
        except anyio.get_cancelled_exc_class():
            cancel.set()
            raise
        except Cancelled as error:
            raise ToolError("the simulation was cancelled") from error
        except SimulationError as error:
            raise ToolError(str(error)) from error
        except Exception as error:  # noqa: BLE001 - reported as an engine failure (pulseos.sim/1 prefix)
            raise ToolError(f"engine error: {type(error).__name__}: {error}") from error
        return {"resultKey": resultKey, "parts": parts, "stats": result.stats, "timing": result.timing,
                "grid": result.grid, "warnings": result.warnings, "device": device, "phantomHash": maps.content_hash()}

    return mcp


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="mrzero-mcp", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command")
    serve = sub.add_parser("serve", help="run the MCP server on stdio (default)")
    prep = sub.add_parser("prepare-phantoms", help="download BrainWeb and store the axial slice phantom")
    for p in (parser, serve, prep):
        p.add_argument("--phantoms", default=os.environ.get("MRZERO_PHANTOMS", str(Path.home() / ".cache/mrzero-mcp/phantoms")))
    for p in (parser, serve):
        p.add_argument("--out", default=os.environ.get("MRZERO_OUT"))
        p.add_argument("--device", default=os.environ.get("MRZERO_DEVICE", "auto"))
    args = parser.parse_args(argv)
    if args.command == "prepare-phantoms":
        from .phantoms import prepare_brainweb

        print(prepare_brainweb(Path(args.phantoms)))
        return
    if not args.out:
        parser.error("--out (or MRZERO_OUT) is required")
    mcp_fd = _isolate_stdout()
    device = _device(args.device)
    server = build_server(Path(args.out), Path(args.phantoms), device)

    import anyio
    from mcp.server.stdio import stdio_server

    async def run() -> None:
        stdout = anyio.wrap_file(os.fdopen(mcp_fd, "w", encoding="utf-8", newline="\n", buffering=1))
        async with stdio_server(stdout=stdout) as (read, write):
            low = server._mcp_server
            await low.run(read, write, low.create_initialization_options())

    anyio.run(run)


if __name__ == "__main__":
    main()

"""End-to-end: the server over real MCP stdio, with progress and cancellation."""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import anyio
import numpy as np
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SEQ = Path(os.environ.get("MRZERO_TEST_SEQ", Path(__file__).parent / "data/gre2d.seq"))


def params(out: Path) -> StdioServerParameters:
    return StdioServerParameters(
        command=sys.executable, args=["-m", "mrzero_mcp.server", "--out", str(out), "--device", os.environ.get("MRZERO_TEST_DEVICE", "cpu")],
        env={**os.environ, "MRZERO_PHANTOMS": os.environ.get("MRZERO_PHANTOMS", str(out / "phantoms"))},
    )


def key(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


async def _session(out: Path, body):
    async with stdio_client(params(out)) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await body(session)


def test_tools_and_simulate(tmp_path: Path) -> None:
    seq_text = SEQ.read_text()
    seen: list[tuple[float, float | None]] = []

    async def body(session: ClientSession):
        tools = {t.name for t in (await session.list_tools()).tools}
        assert tools == {"engine_info", "list_phantoms", "simulate"}
        info = (await session.call_tool("engine_info", {})).structuredContent
        assert info["protocol"] == "pulseos.sim/1" and info["engine"] == "mrzero"
        phantoms = (await session.call_tool("list_phantoms", {})).structuredContent["phantoms"]
        assert "tubes" in [p["id"] for p in phantoms]

        async def on_progress(progress: float, total: float | None, message: str | None) -> None:
            seen.append((progress, total))

        result = await session.call_tool("simulate", {"seqText": seq_text, "seqHash": "sha256:x", "phantom": "tubes",
                                                      "resultKey": key("a"), "settings": {}}, progress_callback=on_progress)
        assert not result.isError, result.content
        return result.structuredContent

    reply = anyio.run(_session, tmp_path, body)
    assert reply["grid"]["nx"] == 64 and reply["grid"]["ny"] == 64 and reply["grid"]["cartesian"]
    assert seen and seen[-1][0] == seen[-1][1]
    meta = json.loads((tmp_path / key("a") / "meta.json").read_text())
    image = np.fromfile(tmp_path / key("a") / meta["parts"]["image"]["file"], "<c8").reshape(meta["parts"]["image"]["shape"])
    assert image.shape == (64, 64) and np.abs(image).max() > 0
    means = reply["stats"]["tissueMeans"]
    # Spoiled GRE, TR 10 ms, flip 15 deg: short-T1 fat-like vial brighter than the long-T1 CSF-like one.
    assert means["fat-like"] > means["csf-like"]


def test_rejects_bad_inputs(tmp_path: Path) -> None:
    async def body(session: ClientSession):
        bad_key = await session.call_tool("simulate", {"seqText": "x", "seqHash": "h", "phantom": "tubes", "resultKey": "../x"})
        bad_phantom = await session.call_tool("simulate", {"seqText": "x", "seqHash": "h", "phantom": "nope", "resultKey": key("b")})
        bad_seq = await session.call_tool("simulate", {"seqText": "not a seq", "seqHash": "h", "phantom": "tubes", "resultKey": key("c")})
        return bad_key, bad_phantom, bad_seq

    bad_key, bad_phantom, bad_seq = anyio.run(_session, tmp_path, body)
    assert bad_key.isError and "hex" in bad_key.content[0].text
    assert bad_phantom.isError and "unknown phantom" in bad_phantom.content[0].text
    assert bad_seq.isError


def test_cancel_stops_between_repetitions(tmp_path: Path) -> None:
    seq_text = SEQ.read_text()

    async def body(session: ClientSession):
        started = anyio.Event()

        async def on_progress(progress: float, total: float | None, message: str | None) -> None:
            started.set()

        async with anyio.create_task_group() as group:
            async def call():
                await session.call_tool("simulate", {"seqText": seq_text, "seqHash": "h", "phantom": "tubes", "resultKey": key("d"),
                                                     "settings": {"resolution": 128}}, progress_callback=on_progress)
            group.start_soon(call)
            await started.wait()
            group.cancel_scope.cancel()
        # The server still answers after a cancelled call.
        return (await session.call_tool("engine_info", {})).structuredContent

    assert anyio.run(_session, tmp_path, body)["engine"] == "mrzero"
    assert not (tmp_path / key("d")).exists()

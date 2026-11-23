# MRzero MCP server for PulseOS (AGPL-3.0-only; see LICENSE). Runs as a non-root user and is
# meant to be started with a read-only root filesystem and no network (see README.md).
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_PYTHON_DOWNLOADS=never

WORKDIR /opt/mrzero-mcp
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev --no-install-project
COPY LICENSE README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev

# Bake the BrainWeb slice into the image: the container runs without network.
RUN .venv/bin/mrzero-mcp prepare-phantoms --phantoms /opt/phantoms && rm -rf /opt/phantoms/cache

RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin sim
USER 10001
ENV MRZERO_PHANTOMS=/opt/phantoms MRZERO_OUT=/data HOME=/tmp MPLCONFIGDIR=/tmp PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["/opt/mrzero-mcp/.venv/bin/mrzero-mcp", "serve"]

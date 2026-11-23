/**
 * How an engine process is started. Engines are MCP servers on stdio; `ctx.pulseSim` owns their
 * lifecycle.
 * - `docker`: `docker run -i --rm` with no network, a read-only root filesystem, a non-root user,
 *   no capabilities, `no-new-privileges`, a tmpfs scratch, and only the result directory mounted
 *   writable. The `.seq` text travels inline, so the container needs no other host path.
 * - `local`: the same server as a plain process (no Docker), e.g. the `mrzero-mcp` uv project.
 * - `fake`: the bundled fake engine (tests, CI).
 */
import { fileURLToPath } from 'node:url'

/** Engine configuration. */
export interface EngineConfig {
  launcher: 'docker' | 'local' | 'fake'
  /** Docker image (`docker`). */
  image: string
  /** GPU index for `--gpus device=N` (`docker`); null runs on the CPU. */
  gpu: number | null
  /** Command and arguments (`local`); `--out` and `--device` are appended. */
  command: string[]
  /** Device for `local`: `auto`, `cpu`, `cuda` or `cuda:N`. */
  device: string
  /** Extra environment for `local` (e.g. `MRZERO_PHANTOMS`). */
  env: Record<string, string>
  /** Container memory limit (`docker`), e.g. `16g`. */
  memory: string
  /** Per-step delay of the fake engine, ms. */
  fakeDelayMs: number
}

/** A resolved process to spawn. */
export interface LaunchSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

const FAKE_ENGINE = fileURLToPath(new URL('./fake-engine.ts', import.meta.url))

/**
 * The process that serves one engine.
 * @param engine - engine configuration.
 * @param resultDir - absolute host directory the engine writes results to.
 * @param user - host uid/gid; the container runs as this (non-root) user so results are owned by it.
 * @returns command, arguments and environment.
 */
export function launchSpec(engine: EngineConfig, resultDir: string, user: { uid: number; gid: number }): LaunchSpec {
  const base = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
  switch (engine.launcher) {
    case 'docker': {
      const uid = user.uid === 0 ? 10001 : user.uid
      const gid = user.gid === 0 ? 10001 : user.gid
      const args = [
        'run', '-i', '--rm',
        '--network', 'none',
        '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--user', `${uid}:${gid}`,
        '--pids-limit', '512',
        '--memory', engine.memory,
        '--volume', `${resultDir}:/data:rw`,
        '--env', 'MRZERO_OUT=/data',
        '--env', `MRZERO_DEVICE=${engine.gpu === null ? 'cpu' : 'cuda'}`,
        ...(engine.gpu === null ? [] : ['--gpus', `device=${engine.gpu}`]),
        engine.image,
      ]
      return { command: 'docker', args, env: { ...base, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}), ...(process.env.HOME ? { HOME: process.env.HOME } : {}) } }
    }
    case 'local': {
      const [command, ...args] = engine.command
      if (command === undefined) throw new Error('the local launcher needs a command')
      return { command, args: [...args, '--out', resultDir, '--device', engine.device], env: { ...base, ...(process.env.HOME ? { HOME: process.env.HOME } : {}), ...engine.env } }
    }
    case 'fake':
      return { command: process.execPath, args: [FAKE_ENGINE, '--out', resultDir, '--delay-ms', String(engine.fakeDelayMs)], env: base }
  }
}

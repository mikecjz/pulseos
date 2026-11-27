/**
 * Fake simulation engine: a real MCP server over stdio implementing `pulseos.sim/1` without a
 * simulator, for tests and CI. It reads the ADC layout from the `.seq` text, draws six analytic
 * vials whose brightness depends on the sequence hash (so revisions differ), and computes k-space
 * by DFT. It reports progress once per ADC line and honours cancellation between lines.
 *
 * Run: `node fake-engine.ts --out <dir> [--delay-ms N]`. Test hooks: phantom `broken` fails with
 * an engine error; a `.seq` text without `[ADC]` fails as invalid input.
 * @module @pulseos/sim-service/fake-engine
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const { values } = parseArgs({ options: { out: { type: 'string' }, 'delay-ms': { type: 'string', default: '2' } } })
if (values.out === undefined) throw new Error('fake-engine: --out is required')
const OUT = values.out
const DELAY_MS = Number(values['delay-ms'])

const VIALS = [
  { name: 'a', x: -0.25, y: -0.22, t1: 0.4 }, { name: 'b', x: 0, y: -0.22, t1: 0.8 }, { name: 'c', x: 0.25, y: -0.22, t1: 1.6 },
  { name: 'd', x: -0.25, y: 0.22, t1: 1.2 }, { name: 'e', x: 0, y: 0.22, t1: 1 }, { name: 'f', x: 0.25, y: 0.22, t1: 4 },
]
const PHANTOMS = [
  { id: 'tubes', title: 'Fake vials', description: 'Six analytic vials (fake engine).', dims: [64, 64, 1], fov: [0.2, 0.2, 0.003], tissues: VIALS.map(v => v.name), hash: 'sha256:fake-tubes-1' },
  { id: 'brainweb-axial', title: 'Fake brain', description: 'Stand-in for the BrainWeb slice (fake engine).', dims: [64, 64, 1], fov: [0.2, 0.2, 0.003], tissues: VIALS.map(v => v.name), hash: 'sha256:fake-brain-1' },
  { id: 'broken', title: 'Broken', description: 'Always fails (test hook).', dims: [1, 1, 1], fov: [0.2, 0.2, 0.003], tissues: [], hash: 'sha256:fake-broken-1' },
]

/** ADC count and samples per ADC from the Pulseq text. */
function adcLayout(seqText: string): { count: number; samples: number } | undefined {
  const section = (name: string) => {
    const match = new RegExp(`\\[${name}\\]\\n([\\s\\S]*?)(?:\\n\\[|$)`).exec(seqText)
    return match === null ? [] : match[1]!.split('\n').map(l => l.trim()).filter(l => l !== '' && !l.startsWith('#')).map(l => l.split(/\s+/).map(Number))
  }
  const adcs = section('ADC')
  if (adcs.length === 0) return undefined
  const count = section('BLOCKS').filter(cols => (cols[6] ?? 0) !== 0).length
  return { count, samples: adcs[0]![1]! }
}

function hashUnit(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return ((h >>> 0) % 1000) / 1000
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')) }, { once: true })
})

const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) })

function createServer(): McpServer {
  const server = new McpServer({ name: 'pulseos-fake-engine', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('engine_info', { description: 'Engine info.', inputSchema: z.object({}) }, async () => {
    const info = { protocol: 'pulseos.sim/1', engine: 'fake', title: 'Fake engine (tests)', version: '1.0.0', engineVersion: '1', device: 'cpu', gpu: null, license: 'MIT' }
    return { ...text(JSON.stringify(info)), structuredContent: info }
  })
  server.registerTool('list_phantoms', { description: 'Phantoms.', inputSchema: z.object({}) }, async () => {
    const body = { phantoms: PHANTOMS }
    return { ...text(JSON.stringify(body)), structuredContent: body }
  })
  server.registerTool('simulate', {
    description: 'Fake simulation.',
    inputSchema: z.object({
      seqText: z.string(), seqHash: z.string(), phantom: z.string(), resultKey: z.string(),
      settings: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async (args, ctx): Promise<CallToolResult> => {
    if (!/^[0-9a-f]{64}$/.test(args.resultKey)) return text('resultKey must be 64 lowercase hex digits', true)
    if (args.phantom === 'broken') return text('the fake engine failed on purpose', true)
    if (!PHANTOMS.some(p => p.id === args.phantom)) return text(`unknown phantom "${args.phantom}"`, true)
    const layout = adcLayout(args.seqText)
    if (layout === undefined) return text('the sequence has no [ADC] section', true)
    const ny = layout.count
    const nx = layout.samples
    // oxlint-disable-next-line no-underscore-dangle -- `_meta` is the MCP wire name.
    const token = ctx.mcpReq._meta?.progressToken
    const contrast = hashUnit(args.seqHash)
    // Image: vials at fractions of the FOV; brightness falls with T1, scaled by the sequence hash.
    const image = new Float32Array(nx * ny * 2)
    const means: Record<string, number> = {}
    for (const vial of VIALS) {
      const value = (1 - Math.exp(-0.5 / vial.t1)) * (0.5 + contrast)
      means[vial.name] = value
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const dx = (x + 0.5) / nx - 0.5 - vial.x / 1.25
          const dy = (y + 0.5) / ny - 0.5 - vial.y / 1.25
          if (dx * dx + dy * dy < 0.012) image[(y * nx + x) * 2] = value
        }
      }
    }
    const kspace = new Float32Array(nx * ny * 2)
    for (let ky = 0; ky < ny; ky++) {
      if (ctx.mcpReq.signal.aborted) return text('cancelled', true)
      for (let kx = 0; kx < nx; kx++) {
        let re = 0
        let im = 0
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) {
            const v = image[(y * nx + x) * 2]!
            if (v === 0) continue
            const phase = -2 * Math.PI * ((kx - nx / 2) * x / nx + (ky - ny / 2) * y / ny)
            re += v * Math.cos(phase)
            im += v * Math.sin(phase)
          }
        }
        kspace[(ky * nx + kx) * 2] = re
        kspace[(ky * nx + kx) * 2 + 1] = im
      }
      if (token !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: ky + 1, total: ny, message: `line ${ky + 1}/${ny}` } })
      if (DELAY_MS > 0) {
        try {
          await sleep(DELAY_MS, ctx.mcpReq.signal)
        } catch {
          return text('cancelled', true)
        }
      }
    }
    let peak = 0
    for (let i = 0; i < kspace.length; i += 2) peak = Math.max(peak, Math.hypot(kspace[i]!, kspace[i + 1]!))
    const target = join(OUT, args.resultKey)
    const staging = `${target}.${process.pid}.tmp`
    await mkdir(staging, { recursive: true })
    const parts = {
      image: { file: 'image.c64', shape: [ny, nx], dtype: 'complex64' },
      kspace: { file: 'kspace.c64', shape: [ny, nx], dtype: 'complex64' },
      signal: { file: 'signal.c64', shape: [ny, nx], dtype: 'complex64' },
    }
    await writeFile(join(staging, 'image.c64'), image)
    await writeFile(join(staging, 'kspace.c64'), kspace)
    await writeFile(join(staging, 'signal.c64'), kspace)
    const reply = {
      resultKey: args.resultKey, parts,
      stats: { signalPeak: peak, echoPeak: peak, centreLine: Math.floor(ny / 2), imageMax: 0.5 + contrast, imageMean: 0.1, noiseStd: 0, tissueMeans: means, simResolution: nx, repetitions: ny },
      timing: { simulateMs: ny * DELAY_MS }, grid: { nx, ny, fov: [0.2, 0.2], cartesian: true, samplesPerAdc: nx, adcCount: ny },
      warnings: [], device: 'cpu', phantomHash: PHANTOMS.find(p => p.id === args.phantom)!.hash,
    }
    await writeFile(join(staging, 'meta.json'), JSON.stringify({ protocol: 'pulseos.sim/1', ...reply }))
    await rename(staging, target).catch(() => undefined)
    return { ...text(JSON.stringify({ resultKey: args.resultKey })), structuredContent: reply }
  })
  return server
}

serveStdio(createServer)

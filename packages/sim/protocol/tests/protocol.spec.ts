/** The pulseos.sim/1 reply checks and [[sim:...]] tokens. */
import { describe, expect, it } from 'vitest'
import { decodePart, findSimReferences, formatSimReference, isResultKey, parseEngineInfo, parsePhantoms, parseSimulateReply } from '../src/index.ts'

const key = 'a'.repeat(64)
const part = (file: string) => ({ file, shape: [2, 2], dtype: 'complex64' })
const reply = {
  resultKey: key,
  parts: { image: part('image.c64'), kspace: part('kspace.c64'), signal: part('signal.c64') },
  stats: { signalPeak: 1, tissueMeans: {} },
  grid: { nx: 2, ny: 2 },
}

describe('pulseos.sim/1 replies', () => {
  it('accepts a well-formed simulate reply and fills optional fields', () => {
    expect(parseSimulateReply(reply)).toMatchObject({ resultKey: key, warnings: [], device: 'unknown' })
  })

  it('rejects replies that could escape the result directory or lack parts', () => {
    expect(() => parseSimulateReply({ ...reply, resultKey: '../etc' })).toThrow('resultKey')
    expect(() => parseSimulateReply({ ...reply, parts: { ...reply.parts, image: part('../x.c64') } })).toThrow('"image"')
    expect(() => parseSimulateReply({ ...reply, parts: { image: part('image.c64') } })).toThrow('"kspace"')
    expect(() => parseSimulateReply(undefined)).toThrow('no structured content')
  })

  it('checks engine info and phantom lists', () => {
    expect(() => parseEngineInfo({ protocol: 'other/1', engine: 'x', engineVersion: '1' })).toThrow('expected pulseos.sim/1')
    expect(parseEngineInfo({ protocol: 'pulseos.sim/1', engine: 'x', engineVersion: '1' }).engine).toBe('x')
    expect(() => parsePhantoms({ phantoms: [{ id: 'a' }] })).toThrow('without id or hash')
  })

  it('validates result keys and decodes parts', () => {
    expect(isResultKey(key)).toBe(true)
    expect(isResultKey(key.toUpperCase())).toBe(false)
    expect(decodePart(new Float32Array(8).buffer, { shape: [2, 2] })).toHaveLength(8)
    expect(() => decodePart(new Float32Array(6).buffer, { shape: [2, 2] })).toThrow('expected 32')
  })
})

describe('[[sim:...]] references', () => {
  it('finds and formats tokens', () => {
    const tokens = findSimReferences('compare [[sim:r3/brainweb-axial]] with [[sim:r4/tubes@mrzero]]; not [[sim:3/tubes]]')
    expect(tokens.map(t => [t.rev, t.phantom, t.engine])).toEqual([[3, 'brainweb-axial', null], [4, 'tubes', 'mrzero']])
    expect(formatSimReference(3, 'tubes')).toBe('[[sim:r3/tubes]]')
    expect(formatSimReference(3, 'tubes', 'koma')).toBe('[[sim:r3/tubes@koma]]')
  })
})

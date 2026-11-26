import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { findFreePort, isPortFree, optionValue, withFreeWebPort } from '../web-port.mjs'

const HOST = '127.0.0.1'
const servers = []

/** Listen on an OS-chosen port and keep it held until the test ends. */
async function holdPort(port = 0) {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: HOST, port, exclusive: true }, resolve)
  })
  servers.push(server)
  return server.address().port
}

/** Find a port whose successor is free too, then hold the first one. */
async function holdPortWithFreeSuccessor() {
  for (;;) {
    const port = await holdPort()
    if (port < 65535 && await isPortFree(HOST, port + 1)) return port
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

describe('optionValue', () => {
  it('reads spaced and = forms, last one wins, and stops at --', () => {
    expect(optionValue(['--port', '81'], '--port')).toBe('81')
    expect(optionValue(['--port=82', '--no-open'], '--port')).toBe('82')
    expect(optionValue(['--port', '1', '--port=2'], '--port')).toBe('2')
    expect(optionValue(['--no-open', '--', '--port', '9'], '--port')).toBeUndefined()
    expect(optionValue(['--portal', 'x'], '--port')).toBeUndefined()
  })
})

describe('findFreePort', () => {
  it('skips a held port and returns the next free one', async () => {
    const held = await holdPortWithFreeSuccessor()
    expect(await isPortFree(HOST, held)).toBe(false)
    expect(await findFreePort(HOST, held)).toBe(held + 1)
  })

  it('fails with a hint when every port in the range is held', async () => {
    const held = await holdPort()
    await expect(findFreePort(HOST, held, 1)).rejects.toThrow(/no free port .*pass --port/)
  })
})

describe('withFreeWebPort', () => {
  it('adds --port when none was passed, before a -- terminator', async () => {
    const { args, host, port } = await withFreeWebPort(['--no-open', '--host', HOST, '--', 'x'])
    expect(host).toBe(HOST)
    expect(port).toBeGreaterThanOrEqual(3080)
    expect(args).toEqual(['--no-open', '--host', HOST, '--port', String(port), '--', 'x'])
  })

  it('passes an explicit --port through even when it is taken', async () => {
    const held = await holdPort()
    for (const given of [['--port', String(held)], [`--port=${held}`]]) {
      const result = await withFreeWebPort(given)
      expect(result.args).toEqual(given)
      expect(result.port).toBeUndefined()
    }
  })
})

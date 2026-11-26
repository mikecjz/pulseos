/**
 * Free-port selection for `dsh web` on shared machines.
 *
 * Without `--port`, the launcher probes the bind host from DEFAULT_WEB_PORT
 * upward and passes the first port it can listen on as `--port`. An explicit
 * `--port` is passed through untouched, so a taken port still fails loudly.
 */
import { createServer } from 'node:net'

export const DEFAULT_WEB_PORT = 3080
export const PORT_SCAN_LIMIT = 100
const DEFAULT_WEB_HOST = '127.0.0.1'

/**
 * Read a `--name value` or `--name=value` option from launcher arguments,
 * ignoring anything after a `--` terminator.
 * @param {readonly string[]} args
 * @param {string} name - option name including the leading dashes.
 * @returns {string | undefined} the last value given, `''` for a bare flag, or undefined.
 */
export function optionValue(args, name) {
  let value
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') break
    if (arg === name) value = args[i + 1] ?? ''
    else if (arg.startsWith(`${name}=`)) value = arg.slice(name.length + 1)
  }
  return value
}

/**
 * Report whether a TCP port can be bound on a host right now.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>} false when the port is in use; other bind errors reject.
 */
export function isPortFree(host, port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', error => {
      if (error.code === 'EADDRINUSE') resolve(false)
      else reject(error)
    })
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/**
 * Find the first bindable port at or above `start`.
 * @param {string} host
 * @param {number} [start]
 * @param {number} [limit] - how many consecutive ports to try.
 * @returns {Promise<number>}
 */
export async function findFreePort(host, start = DEFAULT_WEB_PORT, limit = PORT_SCAN_LIMIT) {
  for (let port = start; port < start + limit && port <= 65535; port++) {
    if (await isPortFree(host, port)) return port
  }
  throw new Error(`no free port on ${host} in ${start}-${Math.min(start + limit - 1, 65535)}; pass --port <port> to choose one`)
}

/**
 * Add a free `--port` to `dsh web` arguments when the caller named none.
 * @param {readonly string[]} args - arguments after the profile name.
 * @returns {Promise<{ args: string[], host: string, port?: number }>}
 *   `port` is set only when this function chose it.
 */
export async function withFreeWebPort(args) {
  const host = optionValue(args, '--host') || DEFAULT_WEB_HOST
  if (optionValue(args, '--port') !== undefined) return { args: [...args], host }
  const port = await findFreePort(host)
  const end = args.indexOf('--')
  const head = end === -1 ? [...args] : args.slice(0, end)
  const tail = end === -1 ? [] : args.slice(end)
  return { args: [...head, '--port', String(port), ...tail], host, port }
}

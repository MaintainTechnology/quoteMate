/* eslint-disable @typescript-eslint/no-require-imports -- Node --require preloads run before ESM/Vitest. */
// Test-only Node network backstop. This is not an OS or hostile-code sandbox:
// explicit provider mocks may replace fetch, and local sockets/IPC stay usable.
const fs = require('node:fs')
const net = require('node:net')
const { syncBuiltinESMExports } = require('node:module')

const log = process.env.SMS_VALIDATION_NETWORK_LOG
if (!log) throw new Error('Offline test network log is required')
const allowed = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase())
function denied(kind, host) {
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), kind, host: String(host), pid: process.pid }) + '\n')
  const error = new Error(`Offline validation blocked external ${kind}`)
  error.code = 'OFFLINE_NETWORK_BLOCKED'
  return error
}
const originalFetch = globalThis.fetch
globalThis.fetch = async function(input, ...args) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.protocol !== 'data:' && !allowed(url.hostname)) throw denied('fetch', url.hostname)
  return originalFetch.call(this, input, ...args)
}
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function(...args) {
  let value = args[0]
  if (Array.isArray(value)) value = value[0]
  if (value && typeof value === 'object' && value.path) return connect.apply(this, args)
  if (typeof value === 'string' && !/^\d+$/.test(value)) return connect.apply(this, args)
  const host = value && typeof value === 'object' ? value.host ?? 'localhost'
    : typeof args[1] === 'string' ? args[1] : 'localhost'
  if (!allowed(host)) throw denied('socket', host)
  return connect.apply(this, args)
}
syncBuiltinESMExports()

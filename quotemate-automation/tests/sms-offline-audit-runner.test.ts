import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { offlineTestEnvironment, parseOfflineTestArgs, runOfflineTests } from '../scripts/test-sms-audit-offline.mjs'

type ChildOutcome = { error: string | null; exitConfirmed: boolean }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sms-offline-gate-'))
  const runnerPath = join(root, 'fixture-runner.cjs')
  writeFileSync(runnerPath, `
const fs = require('node:fs')
const net = require('node:net')
const tls = require('node:tls')
const report = process.argv.find(x => x.startsWith('--outputFile=')).slice('--outputFile='.length)
const mode = process.env.SMS_OFFLINE_FIXTURE_MODE
async function main() {
  if (mode === 'hang') return setInterval(() => {}, 1000)
  if (mode === 'retained-pipe') {
    const descendant = require('node:child_process').spawn(process.execPath, ['-e', "setInterval(() => process.stdout.write('retained\\\\n'), 25)"], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    descendant.stdout.pipe(process.stdout)
    descendant.stderr.pipe(process.stderr)
    fs.writeFileSync(process.env.SMS_FIXTURE_PID, String(descendant.pid))
    descendant.unref()
    return
  }
  if (mode === 'signal') return process.kill(process.pid, 'SIGTERM')
  if (mode === 'deny') {
    for (const call of [() => fetch('https://external.invalid/secret-path?token=never-log'),
      () => fetch(new Request('https://request.invalid')),
      () => net.connect(443, 'tcp.invalid'), () => tls.connect(443, 'tls.invalid')]) {
      try { await call() } catch (error) { if (error.code !== 'OFFLINE_NETWORK_BLOCKED') throw error }
    }
  }
  if (mode === 'loopback') {
    if (await (await fetch(process.env.SMS_FIXTURE_HTTP)).text() !== 'fixture-ok') throw new Error('loopback fetch failed')
    await new Promise((resolve, reject) => {
      const socket = net.connect(Number(process.env.SMS_FIXTURE_TCP), '127.0.0.1', () => { socket.end(); resolve() })
      socket.on('error', reject)
    })
  }
  if (mode === 'env') {
    if (process.env.GOOGLE_SOLAR_API_KEY !== '' || process.env.CUSTOM_SECRET_VALUE !== '') throw new Error('optional secret survived')
    if (process.env.PUBLIC_WEB_ORIGIN !== 'https://quotemax.com.au' || process.env.LIVE_DB !== '') throw new Error('wrong fixture environment')
    if (!process.env.NODE_OPTIONS.includes('sms-audit-network.cjs')) throw new Error('missing guard')
  }
  if (mode !== 'missing-report') fs.writeFileSync(report, JSON.stringify({ success: mode !== 'bad-report',
    numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numFailedTestSuites: 0 }))
  console.log('fixture completed')
  process.exitCode = mode === 'nonzero' ? 7 : 0
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
`)
  return { root, runnerPath, artifacts: join(root, 'artifacts'), parentEnv: { SystemRoot: process.env.SystemRoot, NODE_ENV: 'test' as const } }
}

it('isolates optional and dotenv credentials without altering the parent or reading their values into the child', () => {
  const { root } = fixture()
  writeFileSync(join(root, '.env.test.local'), 'GOOGLE_SOLAR_API_KEY=local-private-value\nexport CUSTOM_SECRET_VALUE=other-private-value\nUNRELATED_FLAG=enabled\n')
  const parent = { NODE_ENV: 'test' as const, NODE_OPTIONS: '--require=untrusted-parent-hook',
    LIVE_DB: '1', GOOGLE_SOLAR_API_KEY: 'parent-private-value', STRIPE_SECRET_KEY: 'real-like-private-value',
    CUSTOMER_API_URL: 'https://private.invalid', UNRELATED_FLAG: 'inherited', PUBLIC_WEB_ORIGIN: 'https://internal.invalid' }
  const env = offlineTestEnvironment(parent, root)
  expect(env.GOOGLE_SOLAR_API_KEY).toBe('')
  expect(env.CUSTOM_SECRET_VALUE).toBe('')
  expect(env.UNRELATED_FLAG).toBe('')
  expect(env.NODE_OPTIONS).toBe('')
  expect(env.CUSTOMER_API_URL).toBe('https://offline-validation.invalid')
  expect(env.STRIPE_SECRET_KEY).toBe('sk_test_offline_validation')
  expect(env.PUBLIC_WEB_ORIGIN).toBe('https://quotemax.com.au')
  expect(env.LIVE_DB).toBe('')
  expect(parent.GOOGLE_SOLAR_API_KEY).toBe('parent-private-value')
  expect(JSON.stringify(env)).not.toContain('private-value')
})

it('uses explicit constrained Vitest options and treats shell metacharacters as file path data', () => {
  expect(parseOfflineTestArgs(['--artifacts=proof', '--maxWorkers=2', '--', 'tests/a;never-execute.test.ts']))
    .toEqual({ artifacts: resolve('proof'), maxWorkers: 2, timeoutMs: 1_800_000, files: ['tests/a;never-execute.test.ts'] })
  expect(() => parseOfflineTestArgs(['--artifacts=proof', '--', '--setupFiles=other'])).toThrow('Only test file')
  expect(() => parseOfflineTestArgs(['--artifacts=proof', '--maxWorkers=8'])).toThrow('Unknown')
  expect(() => parseOfflineTestArgs(['--artifacts=proof', '--timeoutMs=0'])).toThrow('timeout')
})

it('fails even when a real child catches external fetch, Request, TCP and TLS denials and reports green tests', async () => {
  const options = fixture()
  const result = await runOfflineTests({ ...options, echo: false, parentEnv: { ...options.parentEnv, SMS_OFFLINE_FIXTURE_MODE: 'deny' } })
  expect(result.child).toMatchObject({ code: 0, exitConfirmed: true })
  expect(result.success).toBe(false)
  expect(result.exitCode).toBe(1)
  expect(result.blockedCalls).toEqual([
    expect.objectContaining({ kind: 'fetch', host: 'external.invalid' }),
    expect.objectContaining({ kind: 'fetch', host: 'request.invalid' }),
    expect.objectContaining({ kind: 'socket', host: 'tcp.invalid' }),
    expect.objectContaining({ kind: 'socket', host: 'tls.invalid' }),
  ])
  expect(readFileSync(result.artifacts.networkLog, 'utf8')).not.toContain('secret-path')
  expect(readFileSync(join(options.artifacts, 'offline-result.json'), 'utf8')).toContain('Blocked external network calls: 4')
})

it('allows real loopback HTTP and TCP while recording successful child and report evidence', async () => {
  const http = createServer((_, response) => response.end('fixture-ok'))
  const tcp = createTcpServer(socket => socket.end())
  http.listen(0, '127.0.0.1'); tcp.listen(0, '127.0.0.1')
  await Promise.all([once(http, 'listening'), once(tcp, 'listening')])
  try {
    const options = fixture()
    const result = await runOfflineTests({ ...options, echo: false, parentEnv: { ...options.parentEnv,
      SMS_OFFLINE_FIXTURE_MODE: 'loopback', SMS_FIXTURE_HTTP: 'http://127.0.0.1:' + (http.address() as AddressInfo).port,
      SMS_FIXTURE_TCP: String((tcp.address() as AddressInfo).port) } })
    expect(result).toMatchObject({ success: true, exitCode: 0, blockedCalls: [], errors: [], child: { code: 0, exitConfirmed: true } })
    expect(readFileSync(result.artifacts.log, 'utf8')).toContain('fixture completed')
  } finally {
    http.closeAllConnections()
    await Promise.all([new Promise<void>(resolve => http.close(() => resolve())), new Promise<void>(resolve => tcp.close(() => resolve()))])
  }
})

it('passes only the sanitized child environment and keeps its own denial evidence isolated from the outer run', async () => {
  const options = fixture()
  writeFileSync(join(options.root, '.env.local'), 'CUSTOM_SECRET_VALUE=private-local-value\n')
  const result = await runOfflineTests({ ...options, echo: false, parentEnv: { ...options.parentEnv,
    SMS_OFFLINE_FIXTURE_MODE: 'env', GOOGLE_SOLAR_API_KEY: 'private-parent-value', LIVE_DB: '1',
    SMS_VALIDATION_NETWORK_LOG: join(options.root, 'must-not-create.jsonl') } })
  expect(result.success).toBe(true)
  expect(result.artifacts.networkLog).toBe(join(options.artifacts, 'network-attempts.jsonl'))
})

it.each(['nonzero', 'signal', 'missing-report', 'bad-report'])('rejects a real child %s outcome and preserves diagnostics', async mode => {
  const options = fixture()
  const result = await runOfflineTests({ ...options, echo: false, parentEnv: { ...options.parentEnv, SMS_OFFLINE_FIXTURE_MODE: mode } })
  expect(result.success).toBe(false)
  expect(result.exitCode).toBe(mode === 'nonzero' ? 7 : 1)
  expect(result.errors.length).toBeGreaterThan(0)
  expect(JSON.parse(readFileSync(join(options.artifacts, 'offline-result.json'), 'utf8')).success).toBe(false)
})

it('rejects a real failed spawn and records the failure without a test report', async () => {
  const options = fixture()
  const result = await runOfflineTests({ ...options, echo: false, executable: join(options.root, 'missing-node-executable') })
  expect(result.success).toBe(false)
  expect((result.child as ChildOutcome | null)?.error).toContain('ENOENT')
  expect(result.exitCode).toBe(1)
})

it('bounds and terminates its exact hung child tree and cannot report a deadline as success', async () => {
  const options = fixture()
  const result = await runOfflineTests({ ...options, echo: false, timeoutMs: 300, parentEnv: { ...options.parentEnv, SMS_OFFLINE_FIXTURE_MODE: 'hang' } })
  expect(result).toMatchObject({ success: false, timedOut: true, exitCode: 1, child: { exitConfirmed: true }, cleanup: { requested: true, error: null } })
  expect(result.errors).toContain('Offline test deadline exceeded')
})

it('bounds and terminates a real descendant retaining piped output without masking a deadline', async () => {
  const options = fixture()
  const pidPath = join(options.root, 'descendant.pid')
  const started = Date.now()
  try {
    const result = await runOfflineTests({ ...options, echo: false, timeoutMs: 800, parentEnv: { ...options.parentEnv,
      SMS_OFFLINE_FIXTURE_MODE: 'retained-pipe', SMS_FIXTURE_PID: pidPath } })
    expect(result.success).toBe(false)
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(12_000)
    expect(result.cleanup).toMatchObject({ requested: true, error: null })
    expect((result.child as ChildOutcome | null)?.exitConfirmed).toBe(true)
    expect(readFileSync(result.artifacts.log, 'utf8')).toContain('retained')
  } finally {
    const pid = Number(readFileSync(pidPath, 'utf8'))
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}, 15_000)

it('reports failed termination without live log listeners retaining the runner or writing a closed file', async () => {
  const options = fixture()
  let owned: import('node:child_process').ChildProcess | undefined
  try {
    const result = await runOfflineTests({ ...options, echo: false, timeoutMs: 250, terminationWaitMs: 100,
      parentEnv: { ...options.parentEnv, SMS_OFFLINE_FIXTURE_MODE: 'hang' },
      terminateTestTree: async (child: import('node:child_process').ChildProcess) => {
        owned = child
        return { requested: true, error: 'fixture termination refused' }
      } })
    expect(result).toMatchObject({ success: false, timedOut: true, child: { exitConfirmed: false },
      cleanup: { requested: true, error: 'fixture termination refused' } })
    expect(owned?.stdout?.destroyed).toBe(true)
    expect(owned?.stderr?.destroyed).toBe(true)
    expect(owned?.stdout?.listenerCount('data')).toBe(0)
    expect(result.errors).toContain('Child exit was not confirmed after termination')
  } finally {
    if (owned && owned.exitCode === null && owned.signalCode === null) {
      const closed = once(owned, 'close')
      owned.kill('SIGKILL')
      await closed
    }
  }
})

it.each(['SIGTERM', 'SIGINT'] as const)('handles parent %s cancellation and records owned child termination', async signal => {
  const options = fixture()
  const parentRunner = join(options.root, 'parent-runner.mjs')
  const runnerUrl = pathToFileURL(resolve('scripts/test-sms-audit-offline.mjs')).href
  writeFileSync(parentRunner, `import { runOfflineTests } from ${JSON.stringify(runnerUrl)};
const pending = runOfflineTests(${JSON.stringify({ ...options, echo: false, parentEnv: { ...options.parentEnv, SMS_OFFLINE_FIXTURE_MODE: 'hang' } })});
setTimeout(() => process.emit(${JSON.stringify(signal)}), 400);
const result = await pending;
process.exitCode = result.exitCode;
`)
  const parent = spawn(process.execPath, [parentRunner], { env: options.parentEnv, stdio: 'ignore', windowsHide: true })
  const closed = once(parent, 'close')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [code] = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Parent cancellation exceeded deadline')), 10_000) })])
    expect(code).toBe(signal === 'SIGINT' ? 130 : 143)
    const result = JSON.parse(readFileSync(join(options.artifacts, 'offline-result.json'), 'utf8'))
    expect(result).toMatchObject({ success: false, cancelledBy: signal, child: { exitConfirmed: true }, cleanup: { requested: true, error: null } })
  } finally { clearTimeout(timer); if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL') }
})

it('refuses an existing evidence directory without overwriting a stale green result', async () => {
  const options = fixture()
  mkdirSync(options.artifacts)
  writeFileSync(join(options.artifacts, 'offline-result.json'), 'previous-proof')
  await expect(runOfflineTests({ ...options, echo: false })).rejects.toThrow('must be fresh')
  expect(readFileSync(join(options.artifacts, 'offline-result.json'), 'utf8')).toBe('previous-proof')
})

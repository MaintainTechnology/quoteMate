/** Shared local/CI Vitest gate. Credentials are inert; unmocked external Node
 * fetch/TCP/TLS calls are denied and recorded, even when tests catch the error.
 * This is not an OS sandbox. Next production builds run separately.
 */
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')
const networkGuard = join(here, 'sms-audit-network.cjs')
const require = createRequire(import.meta.url)

export function offlineTestEnvironment(parent = process.env, root = appRoot) {
  const env = { ...parent }
  // Read names, never reuse values. Include test/production/local variants so
  // subsequent dotenv loading cannot restore an optional real credential.
  for (const name of readdirSync(root).filter(name => name === '.env' || name.startsWith('.env.'))) {
    for (const match of readFileSync(join(root, name), 'utf8').matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) {
      env[match[1]] = ''
    }
  }
  for (const key of Object.keys(env)) {
    if (/SECRET|KEY|TOKEN|PASSWORD|DSN|DATABASE_URL|SUPABASE_URL/i.test(key)) env[key] = ''
    if (/(BASE_URL|API_URL|WEBHOOK_URL|ENDPOINT)$/i.test(key)) env[key] = 'https://offline-validation.invalid'
  }
  return Object.assign(env, {
    NODE_ENV: 'test', NODE_OPTIONS: '',
    LIVE_DB: '', LIVE_LLM: '', LIVE_REFINE: '',
    NEXT_PUBLIC_SUPABASE_URL: 'https://offline-db.invalid', SUPABASE_URL: 'https://offline-db.invalid',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'offline-validation-only', SUPABASE_SERVICE_ROLE_KEY: 'offline-validation-only',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_Y2xlcmsub2ZmbGluZS50ZXN0JA==', CLERK_SECRET_KEY: 'sk_test_offline_validation',
    STRIPE_SECRET_KEY: 'sk_test_offline_validation', NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_offline_validation',
    RESEND_API_KEY: 're_offline_validation', TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'offline-validation-only',
    SENTRY_AUTH_TOKEN: '', SENTRY_DSN: '', NEXT_PUBLIC_SENTRY_DSN: '',
    NEXT_TELEMETRY_DISABLED: '1', CLERK_TELEMETRY_DISABLED: '1',
    APP_URL: 'https://quotemax.com.au', PUBLIC_WEB_ORIGIN: 'https://quotemax.com.au', NEXT_PUBLIC_APP_URL: 'https://quotemax.com.au',
    ENGINE_BASE_URL: 'https://offline-engine.invalid', TENANT_FILESTORE_ENABLED: 'false', SMS_QUOTE_PDF_MMS: '0',
  })
}

export function parseOfflineTestArgs(args) {
  const options = { artifacts: '', maxWorkers: 1, timeoutMs: 1_800_000, files: [] }
  let files = false
  for (const arg of args) {
    if (files) {
      if (arg.startsWith('-')) throw new Error('Only test file paths are allowed after --')
      options.files.push(arg)
    } else if (arg === '--') files = true
    else if (arg.startsWith('--artifacts=')) options.artifacts = resolve(arg.slice('--artifacts='.length))
    else if (/^--maxWorkers=[12]$/.test(arg)) options.maxWorkers = Number(arg.split('=')[1])
    else if (/^--timeoutMs=\d+$/.test(arg)) options.timeoutMs = Number(arg.split('=')[1])
    else throw new Error(`Unknown offline test option: ${arg}`)
  }
  if (!options.artifacts) throw new Error('--artifacts=<fresh directory> is required')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 1_800_000) {
    throw new Error('Offline test timeout must be 1000–1800000 ms')
  }
  return options
}

async function killOwnedTestTree(child) {
  if (!child.pid) return { requested: false, error: null }
  try {
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, error => error ? reject(error) : resolve())
      })
    } else process.kill(-child.pid, 'SIGKILL')
    return { requested: true, error: null }
  } catch (error) {
    return { requested: true, error: String(error.message) }
  }
}

// runnerPath is an internal subprocess-test seam; the CLI always resolves the
// installed Vitest entry point. No shell or arbitrary CLI command is accepted.
export async function runOfflineTests({ artifacts, maxWorkers = 1, timeoutMs = 1_800_000, files = [],
  root = appRoot, parentEnv = process.env, runnerPath = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), executable = process.execPath,
  echo = true, terminateTestTree = killOwnedTestTree, terminationWaitMs = 7000 }) {
  artifacts = resolve(artifacts)
  if (existsSync(artifacts)) throw new Error('Offline test artifact directory must be fresh: ' + artifacts)
  mkdirSync(artifacts, { recursive: true })
  const networkLog = join(artifacts, 'network-attempts.jsonl')
  const testReport = join(artifacts, 'vitest-results.json')
  const logFd = openSync(join(artifacts, 'vitest.log'), 'wx')
  writeFileSync(networkLog, '', { flag: 'wx' })
  const env = offlineTestEnvironment(parentEnv, root)
  // Quoting is parsed by Node's NODE_OPTIONS grammar, not a shell. Inherited
  // options/preloads are deliberately replaced; descendants inherit this one.
  env.NODE_OPTIONS = '--require=' + JSON.stringify(networkGuard)
  env.SMS_VALIDATION_NETWORK_LOG = networkLog
  const args = [runnerPath, 'run', `--maxWorkers=${maxWorkers}`, '--testTimeout=20000',
    '--reporter=default', '--reporter=json', `--outputFile=${testReport}`, ...files]
  const result = { startedAt: new Date().toISOString(), finishedAt: null, success: false, exitCode: 1,
    child: null, timedOut: false, cancelledBy: null, cleanup: null, blockedCalls: [], errors: [], testCounts: null,
    artifacts: { networkLog, testReport, log: join(artifacts, 'vitest.log') },
    harnessHashes: Object.fromEntries([fileURLToPath(import.meta.url), networkGuard].map(path =>
      [path, createHash('sha256').update(readFileSync(path)).digest('hex')])),
    limits: 'Node fetch/TCP/TLS backstop; provider mocks and local sockets allowed; not an OS sandbox or production build.' }
  let child
  let stopOnInterrupt, stopOnTerminate
  try {
    child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, detached: process.platform !== 'win32' })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      writeSync(logFd, data)
      if (echo) process.stdout.write(data)
    })
    let timeout, cleanupDeadline
    let killFinished = Promise.resolve()
    result.child = await new Promise(resolve => {
      const finish = value => { clearTimeout(timeout); clearTimeout(cleanupDeadline); resolve(value) }
      const stop = signal => {
        if (result.timedOut || result.cancelledBy) return
        if (signal) result.cancelledBy = signal
        else result.timedOut = true
        clearTimeout(timeout)
        killFinished = Promise.resolve().then(() => terminateTestTree(child))
          .then(value => { result.cleanup = value }, error => { result.cleanup = { requested: true, error: String(error.message) } })
        cleanupDeadline = setTimeout(() => finish({ code: null, signal: null,
          error: 'Child exit was not confirmed after termination', exitConfirmed: false }), terminationWaitMs)
      }
      stopOnInterrupt = () => stop('SIGINT')
      stopOnTerminate = () => stop('SIGTERM')
      process.on('SIGINT', stopOnInterrupt)
      process.on('SIGTERM', stopOnTerminate)
      child.once('error', error => finish({ code: null, signal: null, error: error.message, exitConfirmed: false }))
      child.once('close', (code, signal) => finish({ code, signal, error: null, exitConfirmed: true }))
      timeout = setTimeout(() => stop(null), timeoutMs)
    })
    await killFinished
    if (result.child.error) result.errors.push(result.child.error)
    if (result.timedOut) result.errors.push('Offline test deadline exceeded')
    if (result.cancelledBy) result.errors.push('Offline test runner cancelled by ' + result.cancelledBy)
    if (result.child.code !== 0 || result.child.signal) result.errors.push('Vitest child did not exit successfully')
    if (result.cleanup?.error) result.errors.push('Owned test process termination was not confirmed: ' + result.cleanup.error)
  } catch (error) {
    result.errors.push(error.message)
  } finally {
    if (stopOnInterrupt) process.removeListener('SIGINT', stopOnInterrupt)
    if (stopOnTerminate) process.removeListener('SIGTERM', stopOnTerminate)
    child?.stdout?.removeAllListeners('data')
    child?.stderr?.removeAllListeners('data')
    child?.stdout?.destroy()
    child?.stderr?.destroy()
    if (result.child?.exitConfirmed !== true) child?.unref()
    closeSync(logFd)
  }
  try {
    result.blockedCalls = readFileSync(networkLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (result.blockedCalls.length) result.errors.push(`Blocked external network calls: ${result.blockedCalls.length}`)
  } catch (error) { result.errors.push('Network evidence could not be read: ' + error.message) }
  try {
    const tests = JSON.parse(readFileSync(testReport, 'utf8'))
    result.testCounts = Object.fromEntries(['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numFailedTestSuites'].map(key => [key, tests[key]]))
    if (tests.success !== true || !(tests.numPassedTests > 0) || tests.numFailedTests !== 0 || tests.numFailedTestSuites !== 0) {
      result.errors.push('Vitest JSON report is missing successful executed test evidence')
    }
  } catch (error) { result.errors.push('Vitest JSON report could not be read: ' + error.message) }
  result.success = result.errors.length === 0
  result.exitCode = result.success ? 0 : result.cancelledBy === 'SIGINT' ? 130 : result.cancelledBy === 'SIGTERM' ? 143
    : (Number.isInteger(result.child?.code) && result.child.code > 0 ? result.child.code : 1)
  result.finishedAt = new Date().toISOString()
  writeFileSync(join(artifacts, 'offline-result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runOfflineTests(parseOfflineTestArgs(process.argv.slice(2)))
    console.log(JSON.stringify({ success: result.success, exitCode: result.exitCode, blockedCalls: result.blockedCalls.length,
      errors: result.errors, report: join(dirname(result.artifacts.networkLog), 'offline-result.json') }))
    process.exitCode = result.exitCode
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}

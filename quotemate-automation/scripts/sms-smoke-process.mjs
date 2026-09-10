import { setTimeout as delay } from 'node:timers/promises'

/** Capture process termination before any HTTP request, including spawn errors.
 * @param {import('node:child_process').ChildProcess} child
 */
export function observeSmokeChild(child) {
  let output = '', terminal = null, processError = null, finish
  const exited = new Promise((resolve) => { finish = resolve })
  const capture = (chunk) => { output = (output + String(chunk)).slice(-3000) }
  child.stdout?.on('data', capture)
  child.stderr?.on('data', capture)
  child.once('exit', (code, signal) => {
    terminal = { code, signal }
    finish(terminal)
  })
  child.on('error', (error) => {
    processError = error
    // A failed spawn has no process to terminate. Other errors do not prove exit.
    if (!child.pid) { terminal = { error }; finish(terminal) }
  })
  return { child, exited, get output() { return output }, get terminal() { return terminal },
    get processError() { return processError } }
}

/** The deadline includes response-body consumption as well as HTTP headers.
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<{status: number, ok: boolean, body: string}>}
 */
export async function readSmokeResponse(url, init = {}, timeoutMs = 1000) {
  const controller = new AbortController()
  let timer, onAbort
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('Smoke HTTP deadline exceeded after ' + timeoutMs + 'ms: ' + url))
    }, timeoutMs)
    onAbort = () => {
      controller.abort(init.signal?.reason)
      reject(init.signal?.reason ?? new Error('Smoke request aborted'))
    }
    if (init.signal?.aborted) onAbort()
    else init.signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(url, { ...init, signal: controller.signal })
      const body = await response.text()
      return { status: response.status, ok: response.ok, body }
    })()])
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onAbort)
    controller.abort()
  }
}

export async function waitForSmokeLiveness(monitor, url, { attempts = 600, pauseMs = 100, requestMs = 1000 } = {}) {
  const started = Date.now()
  let lastRequest = 'no completed request'
  const failure = () => new Error('Service failed to boot after ' + (Date.now() - started) + 'ms: ' +
    (monitor.processError ? 'spawn/process error: ' + monitor.processError.message :
      'exit=' + monitor.terminal?.code + ', signal=' + monitor.terminal?.signal) + '\n' + monitor.output)
  const lifetime = new AbortController()
  monitor.exited.then(() => lifetime.abort(failure()))
  try {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (monitor.terminal || monitor.processError) throw failure()
    try {
      const live = await readSmokeResponse(url, { signal: lifetime.signal }, requestMs)
      if (live.ok) return live
      lastRequest = 'HTTP ' + live.status
    } catch (error) {
      if (monitor.terminal || monitor.processError) throw failure()
      lastRequest = String(error)
    }
    await delay(pauseMs, undefined, { signal: lifetime.signal })
  }
  throw new Error('Liveness unavailable after ' + (Date.now() - started) + 'ms and ' + attempts +
    ' attempts; last request: ' + lastRequest + '\n' + monitor.output)
  } catch (error) {
    if (monitor.terminal || monitor.processError) throw failure()
    throw error
  } finally { lifetime.abort() }
}

/** TERM and confirmed KILL share the original three-second cleanup budget. */
export async function stopSmokeChild(monitor, { totalMs = 3000, termMs = 2000 } = {}) {
  if (monitor.terminal) return
  let deadlineTimer, killTimer, killError
  const signal = (name) => {
    try { monitor.child.kill(name) } catch (error) { killError = error }
  }
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('Smoke cleanup deadline exceeded without confirmed exit' +
      (killError ? ': ' + killError.message : ''))), totalMs)
    killTimer = setTimeout(() => signal('SIGKILL'), Math.min(termMs, totalMs))
  })
  try {
    signal('SIGTERM')
    await Promise.race([monitor.exited, deadline])
  } finally {
    clearTimeout(deadlineTimer)
    clearTimeout(killTimer)
  }
}

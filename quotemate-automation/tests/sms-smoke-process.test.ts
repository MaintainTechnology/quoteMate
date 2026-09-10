import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { observeSmokeChild, readSmokeResponse, stopSmokeChild, waitForSmokeLiveness } from '../scripts/sms-smoke-process.mjs'

const children: Array<{ monitor: ReturnType<typeof observeSmokeChild>; kill: ChildProcess['kill'] }> = []
const servers: Server[] = []
function track(child: ChildProcess) {
  const monitor = observeSmokeChild(child)
  children.push({ monitor, kill: child.kill.bind(child) })
  return monitor
}
function fixtureChild() {
  return track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: { SystemRoot: process.env.SystemRoot, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }))
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { monitor, kill } of children.splice(0)) {
    monitor.child.kill = kill
    if (!monitor.terminal) {
      kill('SIGKILL')
      await Promise.race([monitor.exited, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture child did not exit')), 3000)
        monitor.exited.then(() => clearTimeout(timer))
      })])
    }
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('reports a real failed spawn without exhausting the startup attempt budget', async () => {
  const monitor = track(spawn(join(tmpdir(), 'missing-smoke-executable-' + randomUUID()), [], { windowsHide: true }))
  await expect(waitForSmokeLiveness(monitor, 'http://127.0.0.1:9')).rejects.toThrow('spawn/process error')
  expect(monitor.terminal?.error).toBeDefined()
  await expect(stopSmokeChild(monitor)).resolves.toBeUndefined()
})

it('detects actual signal termination during startup and cancels its pending probe', async () => {
  let received!: () => void, closed!: () => void
  const requestReceived = new Promise<void>((resolve) => { received = resolve })
  const responseClosed = new Promise<void>((resolve) => { closed = resolve })
  const server = createServer((_, response) => {
    response.writeHead(200)
    response.write('unfinished')
    response.once('close', closed)
    received()
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const monitor = fixtureChild()
  await once(monitor.child, 'spawn')
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const waiting = waitForSmokeLiveness(monitor, url)
  const rejected = expect(waiting).rejects.toThrow('signal=SIGKILL')
  await requestReceived
  monitor.child.kill('SIGKILL')
  await rejected
  await responseClosed
  expect(monitor.terminal?.signal).toBe('SIGKILL')
})

it('confirms actual child exit after escalation when TERM does not stop it', async () => {
  const monitor = fixtureChild()
  await once(monitor.child, 'spawn')
  const realKill = monitor.child.kill.bind(monitor.child)
  const signals: string[] = []
  monitor.child.kill = (signal) => {
    signals.push(String(signal))
    return signal === 'SIGTERM' ? true : realKill(signal)
  }
  await stopSmokeChild(monitor, { termMs: 20, totalMs: 1000 })
  expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(monitor.terminal?.signal).toBe('SIGKILL')
})

it('fails cleanup if termination is not confirmed instead of reporting success', async () => {
  const monitor = fixtureChild()
  await once(monitor.child, 'spawn')
  monitor.child.kill = () => false
  await expect(stopSmokeChild(monitor, { termMs: 20, totalMs: 100 })).rejects.toThrow('without confirmed exit')
  expect(monitor.terminal).toBeNull()
  // afterEach restores the real kill function and terminates this exact fixture.
})

it.each(['headers', 'body'])('bounds a real HTTP response stalled at %s', async (stage) => {
  const server = createServer((_, response) => {
    if (stage === 'body') { response.writeHead(200); response.write('unfinished') }
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  await expect(readSmokeResponse(url, {}, 50)).rejects.toThrow('Smoke HTTP deadline exceeded')
})

it('honours caller cancellation while consuming an actual unfinished body', async () => {
  const controller = new AbortController()
  let reading!: () => void
  const bodyStarted = new Promise<void>((resolve) => { reading = resolve })
  const actualFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await actualFetch(input, init)
    const actualText = response.text.bind(response)
    response.text = () => { reading(); return actualText() }
    return response
  })
  const server = createServer((_, response) => {
    response.writeHead(200)
    response.write('unfinished')
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const request = readSmokeResponse(url, { signal: controller.signal }, 1000)
  const rejected = expect(request).rejects.toThrow('caller stopped smoke request')
  await bodyStarted
  controller.abort(new Error('caller stopped smoke request'))
  await rejected
})

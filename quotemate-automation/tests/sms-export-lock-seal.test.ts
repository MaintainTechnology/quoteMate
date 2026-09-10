import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { afterAll, expect, it } from 'vitest'
import { sealReceptionistRelease } from '../scripts/seal-receptionist-release.mjs'
import { REQUIRED_RECEPTIONIST_MIGRATIONS } from '../scripts/receptionist-schema-contract.mjs'

const directories: string[] = []
afterAll(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })))
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qm-lock-seal-'))
  directories.push(directory)
  mkdirSync(join(directory, 'src'))
  writeFileSync(join(directory, 'src/index.ts'), 'export const ready = true\n')
  writeFileSync(join(directory, 'package.json'), '{"dependencies":{"parent":"1.0.0"}}')
  const generatedHashes = { 'src/index.ts': hash('export const ready = true\n') }
  const buildInputHashes = { 'package.json': hash('{"dependencies":{"parent":"1.0.0"}}') }
  const manifest = { contractVersion: 2, trade: 'front-desk', approvalRequired: true,
    requiredMigrations: REQUIRED_RECEPTIONIST_MIGRATIONS, generatedHashes, buildInputHashes,
    sourceHash: hash(JSON.stringify({ generatedHashes, buildInputHashes })) }
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify(manifest))
  const lock = { lockfileVersion: 3, packages: { '': { dependencies: { parent: '1.0.0' } },
    'node_modules/parent': { version: '1.0.0' }, 'node_modules/child': { version: '1.0.0' } } }
  return { directory, manifest, lock }
}

it('seals a freshly resolved lock without changing it and repeat sealing retains identity', () => {
  const { directory, manifest, lock } = fixture()
  const exactLock = JSON.stringify(lock)
  writeFileSync(join(directory, 'package-lock.json'), exactLock)
  const sealed = sealReceptionistRelease(directory)
  expect(sealed.buildInputHashes['package-lock.json']).toBe(hash(exactLock))
  expect(sealed.sourceHash).not.toBe(manifest.sourceHash)
  expect(readFileSync(join(directory, 'package-lock.json'), 'utf8')).toBe(exactLock)
  expect(sealReceptionistRelease(directory).sourceHash).toBe(sealed.sourceHash)
})

it('rejects transitive-only lock tampering even though direct dependencies are unchanged', () => {
  const { directory, lock } = fixture()
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify(lock))
  const sealed = sealReceptionistRelease(directory)
  lock.packages['node_modules/child'].version = '2.0.0'
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify(lock))
  expect(lock.packages['node_modules/parent'].version).toBe('1.0.0')
  expect(() => sealReceptionistRelease(directory)).toThrow('Unreviewed release input: package-lock.json')
  expect(JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8')).sourceHash).toBe(sealed.sourceHash)
  // Run the actual promotion CLI too: hash verification must reject the lock
  // before loading any built runtime or consulting dependency versions.
  const verified = spawnSync(process.execPath, [join(process.cwd(), 'scripts/verify-receptionist-release.mjs'), directory], { encoding: 'utf8' })
  expect(verified.status).not.toBe(0)
  expect(verified.stderr).toContain('Unreviewed build input: package-lock.json')
})

it('does not seal absent locks or modified source files', () => {
  const { directory, lock } = fixture()
  expect(() => sealReceptionistRelease(directory)).toThrow('package-lock.json')
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify(lock))
  writeFileSync(join(directory, 'src/index.ts'), 'export const ready = false\n')
  expect(() => sealReceptionistRelease(directory)).toThrow('Unreviewed release input: src/index.ts')
})

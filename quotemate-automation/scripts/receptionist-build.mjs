#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync, renameSync } from 'node:fs'
import { resolve, join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { receptionistSourceHash } from './receptionist-release-fingerprint.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const readManifest = (directory) => JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'))

export function compiledOutputHashes(directory) {
  const hashes = {}
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(folder, entry.name)
      assert.ok(!entry.isSymbolicLink(), `Compiled output must be self-contained: ${file}`)
      if (entry.isDirectory()) walk(file)
      else hashes[relative(directory, file).split(sep).join('/')] = hash(readFileSync(file))
    }
  }
  walk(join(directory, 'dist'))
  assert.ok(hashes['dist/main.js'], 'Compiled entrypoint is missing')
  return hashes
}

function assertBuildInputs(directory, manifest) {
  assert.equal(manifest.sourceHash, receptionistSourceHash(manifest), 'Release identity does not match build inputs')
  assert.ok(manifest.buildInputHashes?.['package-lock.json'], 'Build requires a sealed package-lock.json')
  for (const [name, expected] of Object.entries({ ...manifest.generatedHashes, ...manifest.buildInputHashes })) {
    assert.equal(hash(readFileSync(join(directory, name))), expected, `Build input changed: ${name}`)
  }
}

export function verifyBuildAttestation(directory, manifest = readManifest(directory)) {
  const proof = JSON.parse(readFileSync(join(directory, 'build-attestation.json'), 'utf8'))
  assert.equal(proof.version, 1, 'Unsupported build attestation')
  assert.equal(proof.sourceHash, manifest.sourceHash, 'Compiled output belongs to a different release; rebuild required')
  assert.deepEqual(compiledOutputHashes(directory), proof.compiledHashes, 'Compiled output changed after build attestation')
  return proof
}

// The only CLI operation compiles. There is no metadata-only command that can
// accidentally attest an old dist tree after a source/manifest refresh.
/**
 * @param {string} directory
 * @param {(command: string, args: string[], options: object) => { status: number | null, error?: Error }} [run]
 */
export function buildReceptionist(directory, run = spawnSync) {
  const manifest = readManifest(directory)
  assertBuildInputs(directory, manifest)
  const proofFile = join(directory, 'build-attestation.json')
  if (existsSync(proofFile)) unlinkSync(proofFile)
  const commands = [[join(directory, 'node_modules/@nestjs/cli/bin/nest.js'), 'build']]
  if (manifest.trade !== 'front-desk') commands.push([join(directory, 'node_modules/tsc-alias/dist/bin/index.js'), '-p', 'tsconfig.json'])
  for (const args of commands) {
    const result = run(process.execPath, args, { cwd: directory, stdio: 'inherit', windowsHide: true })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `Compiler failed: ${relative(directory, args[0])}`)
  }
  const after = readManifest(directory)
  assert.equal(after.sourceHash, manifest.sourceHash, 'Release changed during compilation')
  assertBuildInputs(directory, after)
  const proof = { version: 1, sourceHash: after.sourceHash, builtAt: new Date().toISOString(), compiledHashes: compiledOutputHashes(directory) }
  const temporary = join(directory, `.build-attestation-${process.pid}.tmp`)
  writeFileSync(temporary, JSON.stringify(proof, null, 2) + '\n')
  renameSync(temporary, proofFile)
  console.log(`ATTESTED ${manifest.trade}: ${proof.sourceHash}; ${Object.keys(proof.compiledHashes).length} compiled outputs`)
  return proof
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildReceptionist(resolve(process.argv[2] ?? '.'))
}

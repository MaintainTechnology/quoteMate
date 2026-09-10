#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { receptionistSourceHash } from './receptionist-release-fingerprint.mjs'

const hash = (content) => createHash('sha256').update(content).digest('hex')

// A fresh export has no npm lock until dependency resolution. Seal that exact
// lock once; never bless changed sources, build inputs or an already sealed lock.
export function sealReceptionistRelease(directory) {
  const file = join(directory, 'release-manifest.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(manifest.contractVersion, 2, 'Unsupported release contract')
  for (const [name, expected] of Object.entries({ ...manifest.generatedHashes, ...manifest.buildInputHashes })) {
    assert.equal(hash(readFileSync(join(directory, name))), expected, `Unreviewed release input: ${name}`)
  }
  assert.equal(manifest.sourceHash, receptionistSourceHash(manifest),
    'Release fingerprint does not match its inputs')
  const lock = readFileSync(join(directory, 'package-lock.json'))
  manifest.buildInputHashes['package-lock.json'] = hash(lock)
  manifest.sourceHash = receptionistSourceHash(manifest)
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = sealReceptionistRelease(resolve(process.argv[2] ?? '.'))
  console.log(`SEALED ${manifest.trade}: ${manifest.sourceHash}; exact package-lock.json included`)
}

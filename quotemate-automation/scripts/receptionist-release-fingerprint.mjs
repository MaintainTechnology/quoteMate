import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

// Trade readiness evidence must name both sides of the release contract: an
// unchanged worker cannot reuse evidence after website approval/rendering changes.
// Front desk has a separately versioned routing contract and keeps its identity.
export function receptionistSourceHash(manifest) {
  const inputs = { generatedHashes: manifest.generatedHashes, buildInputHashes: manifest.buildInputHashes }
  if (manifest.trade !== 'front-desk') {
    assert.ok(manifest.platformContractHashes, 'Trade release identity requires website contract hashes')
    inputs.platformContractHashes = manifest.platformContractHashes
  }
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
}

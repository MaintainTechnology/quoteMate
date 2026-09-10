import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

// These website boundaries can change the meaning or availability of an SMS
// quote even when no copied receptionist module changes. Include their entire
// local import closure, including client components and shared approval helpers.
export const PLATFORM_CONTRACT_ENTRIES = [
  'app/q/[token]/page.tsx', 'app/q/roof/[token]/page.tsx', 'app/q/paint/[token]/page.tsx',
  'app/q/solar/[token]/page.tsx', 'app/q/plan/[token]/page.tsx', 'app/q/aircon/[token]/page.tsx',
  'app/q/commercial-paint/[token]/page.tsx',
  'app/api/quote/[id]/approve/route.ts', 'app/api/quote/[id]/send/route.ts',
  'app/api/quote/[id]/request-final-payment/route.ts',
  'app/api/quote/[id]/issue-final/route.ts',
  'app/api/sms/quote-release/route.ts', 'app/api/sms/status/route.ts',
  'app/api/tenant/sms-delivery/route.ts',
  'app/api/tenant/followups/text/route.ts', 'app/api/tenant/followups/events/route.ts',
  'app/api/tenant/followups/call/route.ts',
  'app/api/tenant/followups/messages/route.ts',
  'app/api/aircon/recommend/route.ts', 'app/api/aircon/plan/route.ts',
  'app/api/tenant/commercial-painting/run/[id]/route.ts',
  'app/api/tenant/commercial-painting/run/[id]/corrections/route.ts',
  'app/dashboard/_components/commercial-painting/CommercialPaintingTab.tsx',
  'app/api/tenant/commercial-painting/price/route.ts',
  'app/api/tenant/commercial-painting/save-quote/route.ts',
  'app/api/tenant/estimator/price/route.ts', 'app/api/tenant/estimator/extract/[id]/route.ts',
  'app/api/upload/plan/[token]/route.ts',
  'app/api/q/[token]/pdf/route.ts', 'app/api/q/[token]/html/route.ts',
  'app/api/q/roof/[token]/pdf/route.ts', 'app/api/q/paint/[token]/pdf/route.ts',
  'app/api/q/solar/[token]/pdf/route.ts', 'app/api/q/plan/[token]/pdf/route.ts',
  'app/api/aircon/pdf/route.ts', 'lib/quote/pdf.ts', 'lib/quote/public-schema.ts', 'app/api/health/sms-contract/route.ts',
]

export function collectPlatformContractFiles(collectClosure, platformRoot) {
  const { files, missing } = collectClosure(PLATFORM_CONTRACT_ENTRIES.map((file) => join(platformRoot, file)))
  if (missing.length) throw new Error(`Unresolved website release contract imports: ${missing.join(', ')}`)
  return [...new Set(files.map((file) => relative(platformRoot, file).split(sep).join('/')))].sort()
}

export function verifyPlatformContractHashes(hashes, platformRoot) {
  assert.ok(hashes, 'No website/source compatibility contract')
  for (const file of PLATFORM_CONTRACT_ENTRIES) {
    assert.ok(hashes[file], `Missing website release boundary: ${file}; re-export this service before promotion`)
  }
  for (const [file, hash] of Object.entries(hashes)) {
    assert.equal(createHash('sha256').update(readFileSync(join(platformRoot, file))).digest('hex'), hash,
      `Platform changed since export: ${file}; rebuild this service before promotion`)
  }
}

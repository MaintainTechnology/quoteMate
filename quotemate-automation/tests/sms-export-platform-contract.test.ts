import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { afterAll, describe, expect, it } from 'vitest'
// The release scripts are executable JavaScript, deliberately independent of Next.
import { PLATFORM_CONTRACT_ENTRIES, collectPlatformContractFiles, verifyPlatformContractHashes } from '../scripts/receptionist-platform-contract.mjs'
import { receptionistSourceHash } from '../scripts/receptionist-release-fingerprint.mjs'

const root = process.cwd()
const exporter = fs.readFileSync('scripts/export-receptionist.mjs', 'utf8')
const graphSource = exporter.slice(exporter.indexOf('const EXTS ='), exporter.indexOf('/** npm package name'))
const collectClosure = runInNewContext(`${graphSource}; collectClosure`, { ...fs, ...path, SRC_ROOT: root })
const directory = fs.mkdtempSync(path.join(tmpdir(), 'qm-release-contract-'))
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

describe('website dependency compatibility contract', () => {
  it('includes transitive approval, document and rendering helpers outside a service closure', () => {
    const files = collectPlatformContractFiles(collectClosure, root)
    expect(files).toContain('lib/quote/customer-release.ts')
    expect(files).toContain('lib/quote/page-owner.ts')
    expect(files).toContain('lib/roofing/approved-promotion.ts')
    expect(files).toContain('lib/quote/pdf.ts')
    expect(files).toContain('app/api/tenant/sms-delivery/route.ts')
    for (const entry of ['app/api/tenant/followups/text/route.ts','app/api/tenant/followups/events/route.ts','app/api/tenant/followups/call/route.ts','app/api/tenant/followups/messages/route.ts']) {
      expect(PLATFORM_CONTRACT_ENTRIES).toContain(entry)
      expect(files).toContain(entry)
    }
    expect(PLATFORM_CONTRACT_ENTRIES).toContain('app/api/quote/[id]/request-final-payment/route.ts')
    expect(files).toContain('app/api/quote/[id]/request-final-payment/route.ts')
    expect(PLATFORM_CONTRACT_ENTRIES).toContain('app/api/quote/[id]/issue-final/route.ts')
    expect(files).toContain('app/api/quote/[id]/issue-final/route.ts')
    expect(files).toContain('app/api/aircon/recommend/route.ts')
    expect(files).toContain('app/api/aircon/plan/route.ts')
    expect(PLATFORM_CONTRACT_ENTRIES).toContain('app/api/tenant/commercial-painting/run/[id]/route.ts')
    expect(files).toContain('app/api/tenant/commercial-painting/run/[id]/route.ts')
    expect(PLATFORM_CONTRACT_ENTRIES).toContain('app/api/tenant/commercial-painting/run/[id]/corrections/route.ts')
    expect(files).toContain('app/api/tenant/commercial-painting/run/[id]/corrections/route.ts')
    expect(PLATFORM_CONTRACT_ENTRIES).toContain('app/dashboard/_components/commercial-painting/CommercialPaintingTab.tsx')
    expect(files).toContain('app/dashboard/_components/commercial-painting/CommercialPaintingTab.tsx')
    expect(files).toContain('app/api/tenant/commercial-painting/price/route.ts')
    expect(files).toContain('app/api/tenant/commercial-painting/save-quote/route.ts')
    expect(files).toContain('app/api/tenant/estimator/price/route.ts')
    expect(files).toContain('app/api/tenant/estimator/extract/[id]/route.ts')
    expect(files).toContain('app/api/upload/plan/[token]/route.ts')
    expect(files.length).toBeGreaterThan(21)
  })

  it('rejects a changed nested helper with unchanged root pages using the real release verifier', () => {
    const files: string[] = collectPlatformContractFiles(collectClosure, root)
    const hashes: Record<string, string> = {}
    for (const file of files) {
      const content = fs.readFileSync(path.join(root, file))
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
      fs.writeFileSync(path.join(directory, file), content)
      hashes[file] = createHash('sha256').update(content).digest('hex')
    }
    expect(() => verifyPlatformContractHashes(hashes, directory)).not.toThrow()
    fs.appendFileSync(path.join(directory, 'lib/quote/customer-release.ts'), '\n// changed approval contract\n')
    expect(createHash('sha256').update(fs.readFileSync(path.join(directory, 'app/q/[token]/page.tsx'))).digest('hex'))
      .toBe(hashes['app/q/[token]/page.tsx'])
    expect(() => verifyPlatformContractHashes(hashes, directory)).toThrow('lib/quote/customer-release.ts')
  })

  it('fails closed for unresolved local imports or a manifest missing a required boundary', () => {
    expect(() => collectPlatformContractFiles(() => ({ files: [], missing: ['@/missing/helper'] }), root))
      .toThrow('Unresolved website release contract imports')
    expect(() => verifyPlatformContractHashes({}, root)).toThrow('Missing website release boundary')
  })

  it.each([
    ['lib/aircon/save-recommendation.ts', 'app/api/aircon/recommend/route.ts'],
    ['lib/commercial-painting/saved-quote.ts', 'app/api/tenant/commercial-painting/save-quote/route.ts'],
    ['lib/commercial-painting/price.ts', 'app/api/tenant/commercial-painting/price/route.ts'],
    ['lib/estimation/pricing-context.ts','app/api/tenant/estimator/price/route.ts'],
    ['lib/storage/plan-pdf.ts','app/api/upload/plan/[token]/route.ts'],
    ['lib/quote/chain-money.ts','app/api/quote/[id]/request-final-payment/route.ts'],
    ['lib/quote/delivery-recipient.ts','app/api/quote/[id]/request-final-payment/route.ts'],
    ['lib/quote/tier-materialise.ts','app/api/quote/[id]/issue-final/route.ts'],
    ['lib/quote/pricing-version.ts','app/api/quote/[id]/issue-final/route.ts'],
    ['lib/quote/followup-contact.ts','app/api/tenant/followups/text/route.ts'],
    ['lib/tenant/from-request.ts','app/api/tenant/followups/events/route.ts'],
    ['lib/commercial-painting/pricing-proof.ts','app/api/tenant/commercial-painting/price/route.ts'],
    ['app/api/tenant/followups/messages/route.ts','app/api/tenant/followups/text/route.ts'],
    ['app/api/tenant/commercial-painting/run/[id]/route.ts','app/api/tenant/commercial-painting/price/route.ts'],
    ['app/api/tenant/commercial-painting/run/[id]/corrections/route.ts','app/api/tenant/commercial-painting/price/route.ts'],
    ['app/dashboard/_components/commercial-painting/CommercialPaintingTab.tsx','app/api/tenant/commercial-painting/price/route.ts'],
    ['lib/commercial-painting/correction-contract.ts','app/api/tenant/commercial-painting/price/route.ts'],
    ['lib/commercial-painting/correction-operations.ts','app/api/tenant/commercial-painting/price/route.ts'],
  ])('rejects a website contract change in %s while its related route stays unchanged', (helper, entry) => {
    const closure: string[] = collectPlatformContractFiles(collectClosure, root)
    expect(closure).toContain(helper)
    const local = fs.mkdtempSync(path.join(directory, 'creation-'))
    const hashes: Record<string, string> = {}
    // The real loader establishes the transitive dependency. A small verifier
    // fixture only needs every mandatory entry plus the helper under test.
    for (const file of [...PLATFORM_CONTRACT_ENTRIES, helper]) {
      const content = fs.readFileSync(path.join(root, file))
      fs.mkdirSync(path.dirname(path.join(local, file)), { recursive: true })
      fs.writeFileSync(path.join(local, file), content)
      hashes[file] = createHash('sha256').update(content).digest('hex')
    }
    expect(() => verifyPlatformContractHashes(hashes, local)).not.toThrow()
    const manifest = { trade: 'electrical', generatedHashes: { 'dist/inbound.js': 'unchanged' },
      buildInputHashes: { 'package-lock.json': 'unchanged' }, platformContractHashes: hashes }
    const originalIdentity = receptionistSourceHash(manifest)
    fs.appendFileSync(path.join(local, helper), '\n// changed persistence or pricing contract\n')
    expect(createHash('sha256').update(fs.readFileSync(path.join(local, entry))).digest('hex')).toBe(hashes[entry])
    expect(() => verifyPlatformContractHashes(hashes, local)).toThrow(helper)
    const changedHash = createHash('sha256').update(fs.readFileSync(path.join(local, helper))).digest('hex')
    expect(receptionistSourceHash({ ...manifest, platformContractHashes: { ...hashes, [helper]: changedHash } })).not.toBe(originalIdentity)
  })

  it('rejects an old manifest missing any newly required creation entry', () => {
    for (const entry of ['app/api/tenant/commercial-painting/run/[id]/route.ts','app/api/tenant/commercial-painting/run/[id]/corrections/route.ts','app/dashboard/_components/commercial-painting/CommercialPaintingTab.tsx',
      'app/api/aircon/recommend/route.ts', 'app/api/aircon/plan/route.ts',
      'app/api/tenant/commercial-painting/price/route.ts', 'app/api/tenant/commercial-painting/save-quote/route.ts',
      'app/api/quote/[id]/request-final-payment/route.ts',
      'app/api/quote/[id]/issue-final/route.ts',
      'app/api/tenant/followups/text/route.ts','app/api/tenant/followups/events/route.ts',
      'app/api/tenant/followups/call/route.ts',
      'app/api/tenant/followups/messages/route.ts',
      'app/api/tenant/estimator/price/route.ts','app/api/tenant/estimator/extract/[id]/route.ts','app/api/upload/plan/[token]/route.ts']) {
      const hashes = Object.fromEntries(PLATFORM_CONTRACT_ENTRIES.map((file: string) => [file, 'placeholder']))
      delete hashes[entry]
      expect(() => verifyPlatformContractHashes(hashes, root)).toThrow(entry)
    }
  })
})

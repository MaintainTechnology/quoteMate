import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind } from 'typescript'
import { receptionistSourceHash } from '../scripts/receptionist-release-fingerprint.mjs'
import { tenantPricingReadiness } from '../lib/sms/pricing-readiness'
import { JOB_QUOTE_OPERATION_SCHEMA } from '../lib/quote/public-schema'

const generatedHashes = { 'src/runtime/readiness.ts': 'unchanged-worker' }
const buildInputHashes = { 'package-lock.json': 'unchanged-lock' }

it('the real compiled readiness probe rejects old evidence after a website-only approval change', async () => {
  const before = { trade: 'electrical', generatedHashes, buildInputHashes,
    platformContractHashes: { 'lib/quote/customer-release.ts': 'approval-before' } }
  const after = { ...before, platformContractHashes: { 'lib/quote/customer-release.ts': 'approval-after' } }
  let manifest = { ...before, contractVersion: 2, sourceHash: receptionistSourceHash(before) }
  let attestedHash: string | null = manifest.sourceHash
  const acceptedEvidence = new Map([[manifest.sourceHash, { passed: true, verified_at: new Date().toISOString() }]])
  const runtime = { exports: {} }
  const db = { from(table: string) {
    const filters: Record<string, string> = {}
    const result = () => ({ error: null, data: table === 'tenants' ? { trades: ['electrical'], status: 'active' }
      : table === 'pricing_book' ? [{ id: 'pricing',tenant_id:'tenant',trade:'electrical',gst_registered:true }] : table === 'sms_readiness_evidence'
        ? acceptedEvidence.get(filters.release_hash) ?? null : [] })
    const query = {
      select: () => query, limit: () => query, abortSignal: () => query,
      eq: (key: string, value: string) => { filters[key] = value; return query },
      maybeSingle: async () => result(),
      then: (fulfilled: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(fulfilled),
    }
    return query
  },rpc(name:string){
    expect(['sms_commercial_quote_guard_ready','sms_plan_quote_guard_ready','sms_quote_chain_ready']).toContain(name)
    return {abortSignal:()=>Promise.resolve({data:true,error:null})}
  } }
  const code = transpileModule(readFileSync('scripts/receptionist-runtime/readiness.ts.template', 'utf8'),
    { compilerOptions: { module: ModuleKind.CommonJS } }).outputText
  runInNewContext(code, { exports: runtime.exports, module: runtime, AbortSignal,
    process: { cwd: () => '/candidate', env: { CRON_SECRET: 'fixture', SIM_API_KEY: 'fixture', SMS_SIMULATE_ENABLED: '1',
      SMS_READINESS_TENANT_ID: 'tenant', NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture' } },
    require: (name: string) => {
      if (name === '@supabase/supabase-js') return { createClient: () => db }
      if (name === 'node:fs') return { readFileSync: (file: string) => {
        if (!file.endsWith('build-attestation.json')) return JSON.stringify(manifest)
        if (attestedHash === null) throw new Error('ENOENT: build-attestation.json')
        return JSON.stringify({ version: 1, sourceHash: attestedHash })
      } }
      if (name === 'node:path') return { resolve: (...parts: string[]) => parts.join('/') }
      if (name.endsWith('public-schema')) return { verifyPublicQuoteSchema: async () => ({ families: [] }),JOB_QUOTE_OPERATION_SCHEMA }
      if (name.endsWith('public-origin')) return { publicWebOrigin: () => 'https://website.example' }
      if (name.endsWith('pricing-readiness')) return { tenantPricingReadiness }
      throw new Error(`Unexpected runtime dependency: ${name}`)
    },
  })
  const probe = runtime.exports as { receptionistReadiness: (trade: string) => Promise<{ ok: boolean; checks: { name: string; ok: boolean }[] }> }
  expect((await probe.receptionistReadiness('electrical')).ok).toBe(true)
  for (const invalid of [null, 'another-build']) {
    attestedHash = invalid
    const unbuilt = await probe.receptionistReadiness('electrical')
    expect(unbuilt.ok).toBe(false)
    expect(unbuilt.checks.find((check) => check.name === 'release_manifest')?.ok).toBe(false)
  }
  manifest = { ...after, contractVersion: 2, sourceHash: receptionistSourceHash(after) }
  attestedHash = manifest.sourceHash
  const updated = await probe.receptionistReadiness('electrical')
  expect(after.generatedHashes).toBe(before.generatedHashes)
  expect(after.buildInputHashes).toBe(before.buildInputHashes)
  expect(updated.ok).toBe(false)
  expect(updated.checks.filter((check) => !check.ok)).toEqual([{ name: 'synthetic_workflow', ok: false }])
  expect(receptionistSourceHash(after)).not.toBe(receptionistSourceHash(before))
})

it('rejects a trade identity without website hashes and preserves the existing front-desk formula', () => {
  expect(() => receptionistSourceHash({ trade: 'solar', generatedHashes, buildInputHashes }))
    .toThrow('requires website contract hashes')
  expect(receptionistSourceHash({ trade: 'front-desk', generatedHashes, buildInputHashes }))
    .toBe(createHash('sha256').update(JSON.stringify({ generatedHashes, buildInputHashes })).digest('hex'))
})

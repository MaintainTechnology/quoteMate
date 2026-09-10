import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { afterAll, expect, it } from 'vitest'
import { buildReceptionist, verifyBuildAttestation } from '../scripts/receptionist-build.mjs'
import { receptionistSourceHash } from '../scripts/receptionist-release-fingerprint.mjs'
import { REQUIRED_RECEPTIONIST_MIGRATIONS,receptionistSchemaHashes } from '../scripts/receptionist-schema-contract.mjs'

const directories: string[] = []
afterAll(() => directories.forEach((directory) => rmSync(directory, { recursive: true, force: true })))
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'qm-build-proof-'))
  directories.push(directory)
  const files: Record<string, string> = {
    'src/main.ts': 'export const version = "new"\n',
    'dist/main.js': 'exports.version = "old"\n',
    'dist/frontdesk/route-turn.check.js': '// fixture routing boundary\n',
    'dist/frontdesk/durable-inbox.check.js': '// fixture receipt boundary\n',
    'package.json': '{"dependencies":{},"scripts":{"build":"node scripts/receptionist-build.mjs"}}',
    'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    'release-schema.json': JSON.stringify({version:1,requiredMigrations:REQUIRED_RECEPTIONIST_MIGRATIONS,migrationHashes:receptionistSchemaHashes(process.cwd())}),
  }
  for (const name of ['receptionist-build.mjs', 'receptionist-release-fingerprint.mjs']) files[`scripts/${name}`] = readFileSync(`scripts/${name}`, 'utf8')
  for (const [name, value] of Object.entries(files)) {
    mkdirSync(join(directory, name, '..'), { recursive: true })
    writeFileSync(join(directory, name), value)
  }
  const saveManifest = () => {
    const generatedHashes = { 'src/main.ts': hash(readFileSync(join(directory, 'src/main.ts'), 'utf8')) }
    const buildInputHashes = Object.fromEntries(Object.keys(files).filter((name) => name.startsWith('scripts/') || name.startsWith('package') || name==='release-schema.json')
      .map((name) => [name, hash(readFileSync(join(directory, name), 'utf8'))]))
    const manifest = { contractVersion: 2, trade: 'front-desk', approvalRequired: true,
      requiredMigrations: REQUIRED_RECEPTIONIST_MIGRATIONS, generatedHashes, buildInputHashes }
    writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify({ ...manifest, sourceHash: receptionistSourceHash(manifest) }))
  }
  saveManifest()
  const compile = (executable: string, args: string[]) => {
    expect(executable).toBe(process.execPath)
    expect(args).toEqual([normalize(join(directory, 'node_modules/@nestjs/cli/bin/nest.js')), 'build'])
    writeFileSync(join(directory, 'dist/main.js'), 'exports.version = "new"\n')
    return { status: 0 }
  }
  const verify = () => spawnSync(process.execPath, [join(process.cwd(), 'scripts/verify-receptionist-release.mjs'), directory], { encoding: 'utf8' })
  return { directory, saveManifest, compile, verify }
}

it('the actual verifier rejects newly hashed source with stale dist and no build attestation', () => {
  const { verify } = fixture()
  const result = verify()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('build-attestation.json')
})

it('accepts an attested build then rejects a source/manifest refresh without recompilation', () => {
  const { directory, compile, verify, saveManifest } = fixture()
  buildReceptionist(directory, compile)
  expect(verify().status).toBe(0)
  writeFileSync(join(directory, 'src/main.ts'), 'export const version = "next"\n')
  saveManifest()
  const result = verify()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Compiled output belongs to a different release')
})

it('rejects changed and added compiled files even when source and manifest are unchanged', () => {
  const { directory, compile, verify } = fixture()
  buildReceptionist(directory, compile)
  writeFileSync(join(directory, 'dist/main.js'), 'exports.version = "tampered"\n')
  expect(verify().stderr).toContain('Compiled output changed after build attestation')
  writeFileSync(join(directory, 'dist/main.js'), 'exports.version = "new"\n')
  writeFileSync(join(directory, 'dist/extra.js'), '// unexpected compiled file\n')
  expect(() => verifyBuildAttestation(directory)).toThrow('Compiled output changed after build attestation')
})

it('a failed compiler removes old attestation and cannot report a successful build', () => {
  const { directory, compile } = fixture()
  buildReceptionist(directory, compile)
  expect(() => buildReceptionist(directory, () => ({ status: 1 }))).toThrow('Compiler failed')
  expect(existsSync(join(directory, 'build-attestation.json'))).toBe(false)
})

it('refuses attestation if source or the release changes during compilation', () => {
  const { directory, compile, saveManifest } = fixture()
  const changedSource = (executable: string, args: string[]) => {
    const result = compile(executable, args)
    writeFileSync(join(directory, 'src/main.ts'), 'export const version = "raced"\n')
    return result
  }
  expect(() => buildReceptionist(directory, changedSource)).toThrow('Build input changed')
  expect(existsSync(join(directory, 'build-attestation.json'))).toBe(false)
  saveManifest()
  expect(() => buildReceptionist(directory, (executable: string, args: string[]) => {
    const result = compile(executable, args)
    writeFileSync(join(directory, 'src/main.ts'), 'export const version = "raced-again"\n')
    saveManifest()
    return result
  })).toThrow('Release changed during compilation')
  expect(existsSync(join(directory, 'build-attestation.json'))).toBe(false)
})

it.each([
  'sql/migrations/202_job_quote_operations.sql',
  'sql/migrations/211_commercial_quote_release_guard.sql',
  'sql/migrations/212_plan_quote_release_guard.sql',
  'sql/migrations/213_prepare_balance_quote.sql',
  'sql/migrations/214_prepare_final_quote.sql',
  'sql/migrations/215_generic_release_snapshot.sql',
  'sql/migrations/217_final_quote_credit_settlement.sql',
  'sql/migrations/218_sms_quote_chain_readiness.sql',
  'sql/migrations/219_commercial_paint_pricing_proof.sql',
  'sql/migrations/220_followup_operations.sql',
  'sql/migrations/221_commercial_paint_correction_operations.sql',
].flatMap(file=>['omitted','tampered'].map(kind=>({file,kind}))))('the actual verifier rejects $kind $file even in a freshly attested frontdesk build',({file,kind})=>{
  const {directory,compile,saveManifest,verify}=fixture()
  const path=join(directory,'release-schema.json')
  const schema=JSON.parse(readFileSync(path,'utf8'))
  if (kind==='omitted') delete schema.migrationHashes[file]
  else schema.migrationHashes[file]='f'.repeat(64)
  writeFileSync(path,JSON.stringify(schema));saveManifest();buildReceptionist(directory,compile)
  const checked=verify()
  expect(checked.status).not.toBe(0)
  expect(checked.stderr).toContain(`Required schema changed or omitted: ${file}`)
})

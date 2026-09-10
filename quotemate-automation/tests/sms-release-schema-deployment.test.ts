import { afterAll,expect,it } from 'vitest'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,dirname,basename,resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { REQUIRED_RECEPTIONIST_MIGRATIONS,RECEPTIONIST_SCHEMA_FILES,receptionistSchemaHashes,verifyReceptionistSchemaHashes } from '../scripts/receptionist-schema-contract.mjs'
import { receptionistSourceHash } from '../scripts/receptionist-release-fingerprint.mjs'

const temporary:string[]=[]
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const inertEnv={SystemRoot:process.env.SystemRoot,NODE_ENV:'test' as const}
afterAll(()=>{
  for (const directory of temporary) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()))
    expect(basename(directory).startsWith('qm-release-schema-')).toBe(true)
    rmSync(directory,{recursive:true,force:true})
  }
})

it('requires the exact nineteen canonical migration files and rejects omitted or altered approval dependencies',()=>{
  expect(REQUIRED_RECEPTIONIST_MIGRATIONS).toEqual([198,199,200,201,202,204,205,207,210,211,212,213,214,215,217,218,219,220,221])
  expect(RECEPTIONIST_SCHEMA_FILES.map(file=>Number(basename(file).slice(0,3)))).toEqual(REQUIRED_RECEPTIONIST_MIGRATIONS)
  const hashes=receptionistSchemaHashes(process.cwd())
  expect(()=>verifyReceptionistSchemaHashes(hashes,process.cwd())).not.toThrow()
  for(const key of RECEPTIONIST_SCHEMA_FILES) {
    expect(hashes[key]).toBe(hash(readFileSync(key,'utf8')))
    for (const modified of [Object.fromEntries(Object.entries(hashes).filter(([file])=>file!==key)),{...hashes,[key]:'0'.repeat(64)}]) {
      expect(()=>verifyReceptionistSchemaHashes(modified,process.cwd())).toThrow(`Required schema changed or omitted: ${key}`)
    }
  }
})

it('actual frontdesk staging fingerprints schema202 and copies its contract into Docker builder and runtime',()=>{
  const directory=mkdtempSync(join(tmpdir(),'qm-release-schema-'));temporary.push(directory)
  const source=join(directory,'source'),candidate=join(directory,'candidate')
  const files:Record<string,string>={
    'src/main.ts':'export const fixture = true\n',
    'package.json':'{"dependencies":{},"scripts":{"build":"nest build"}}',
    'package-lock.json':'{"lockfileVersion":3,"packages":{}}',
    'tsconfig.json':'{}','nest-cli.json':'{"compilerOptions":{"deleteOutDir":true}}',
    'Dockerfile':'FROM node:22 AS builder\nCOPY tsconfig.json nest-cli.json ./\nFROM node:22 AS runtime\nCOPY --chown=node:node package.json release-manifest.json ./\n',
    '.dockerignore':'node_modules\n','.nvmrc':'22\n','railway.json':'{}','README.md':'Offline source fixture\n','.env.example':'TEST_ONLY=\n',
  }
  for (const [file,content] of Object.entries(files)) {mkdirSync(dirname(join(source,file)),{recursive:true});writeFileSync(join(source,file),content)}
  // The stager's only subprocess is read-only Git provenance. Supply that
  // fixture boundary while running the actual copying/hashing/staging CLI.
  const preload=`import {createRequire,syncBuiltinESMExports} from 'node:module';const require=createRequire(import.meta.url);const cp=require('node:child_process');cp.execFileSync=(command,args,options)=>{if(command!=='git'||JSON.stringify(args)!=='["rev-parse","HEAD"]'||options.cwd!==process.env.FIXTURE_SOURCE)throw new Error('unexpected fixture subprocess');return '0123456789abcdef0123456789abcdef01234567\\n'};for(const name of ['spawn','spawnSync','exec','execSync','execFile','fork'])cp[name]=()=>{throw new Error('unexpected subprocess')};globalThis.fetch=()=>{throw new Error('unexpected provider I/O')};syncBuiltinESMExports();`
  const guard=join(directory,'guard.mjs');writeFileSync(guard,preload)
  const result=spawnSync(process.execPath,['--import',pathToFileURL(guard).href,join(process.cwd(),'scripts/stage-frontdesk-release.mjs'),source,candidate],{encoding:'utf8',env:{...inertEnv,FIXTURE_SOURCE:source},timeout:15000})
  expect(result.status,result.stderr).toBe(0)
  const manifest=JSON.parse(readFileSync(join(candidate,'release-manifest.json'),'utf8'))
  const schemaText=readFileSync(join(candidate,'release-schema.json'),'utf8'),schema=JSON.parse(schemaText)
  expect(manifest.requiredMigrations).toEqual(REQUIRED_RECEPTIONIST_MIGRATIONS)
  expect(schema.migrationHashes).toEqual(receptionistSchemaHashes(process.cwd()))
  expect(manifest.buildInputHashes['release-schema.json']).toBe(hash(schemaText))
  expect(manifest.sourceHash).toBe(receptionistSourceHash(manifest))
  const docker=readFileSync(join(candidate,'Dockerfile'),'utf8')
  expect(docker).toMatch(/COPY tsconfig\.json[^\n]*release-schema\.json \.\//)
  expect(docker).toMatch(/COPY --from=builder[^\n]*\/app\/release-schema\.json \.\//)
  for (const [file,content] of Object.entries(files)) expect(readFileSync(join(source,file),'utf8')).toBe(content)
})

it.each([{args:[]},{args:['roofing']},{args:['--vars-only','solar']},{args:['--candidate=pretend','--yes']}])('legacy deployment fails before credentials, subprocesses or network for $args',({args})=>{
  const directory=mkdtempSync(join(tmpdir(),'qm-release-schema-'));temporary.push(directory)
  const guard=join(directory,'guard.mjs')
  writeFileSync(guard,`import {createRequire,syncBuiltinESMExports} from 'node:module';const require=createRequire(import.meta.url);const fs=require('node:fs');const original=fs.readFileSync;fs.readFileSync=(file,...args)=>{if(/(^|[\\\\/])\\.env(?:\\.|$)/.test(String(file)))throw new Error('CREDENTIAL_READ_FORBIDDEN');return original(file,...args)};const cp=require('node:child_process');for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>{throw new Error('SUBPROCESS_FORBIDDEN')};globalThis.fetch=()=>{throw new Error('PROVIDER_IO_FORBIDDEN')};syncBuiltinESMExports();`)
  const result=spawnSync(process.execPath,['--import',pathToFileURL(guard).href,join(process.cwd(),'scripts/railway-deploy-receptionists.mjs'),...args],{encoding:'utf8',env:inertEnv,timeout:5000})
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('Legacy receptionist deployment is disabled')
  expect(result.stderr).toContain('scripts/verify-receptionist-release.mjs')
  expect(result.stderr).toContain('scripts/seal-receptionist-release.mjs')
  expect(result.stderr).toContain('controlled authenticated capability checks')
  expect(result.stderr).not.toMatch(/CREDENTIAL_READ_FORBIDDEN|SUBPROCESS_FORBIDDEN|PROVIDER_IO_FORBIDDEN|ENOENT|deploy: started/)
})

#!/usr/bin/env node
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, join, relative, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { REQUIRED_RECEPTIONIST_MIGRATIONS, receptionistSchemaHashes } from './receptionist-schema-contract.mjs'
const source = resolve(process.argv[2] ?? '')
const destination = resolve(process.argv[3] ?? '')
const platform = resolve(dirname(fileURLToPath(import.meta.url)),'..')
if (!process.argv[2] || !process.argv[3]) throw new Error('Provide existing frontdesk source and candidate directory')
if (existsSync(destination)) {
  if (!process.argv.includes('--refresh-candidate') || existsSync(join(destination,'.git'))) throw new Error('Existing destination is not a refreshable candidate')
  const previous=JSON.parse(readFileSync(join(destination,'release-manifest.json'),'utf8'))
  for (const [file,hash] of Object.entries(previous.generatedHashes)) {
    if (createHash('sha256').update(readFileSync(join(destination,file))).digest('hex')!==hash) throw new Error(`Candidate edit requires review: ${file}`)
  }
  for (const [file,hash] of Object.entries(previous.buildInputHashes ?? {})) {
    if (createHash('sha256').update(readFileSync(join(destination,file))).digest('hex')!==hash) throw new Error(`Candidate build input requires review: ${file}`)
  }
}
mkdirSync(destination,{recursive:true})
const generatedHashes = {}
function copyTree(path) {
  for (const entry of readdirSync(path,{withFileTypes:true})) {
    const file = join(path,entry.name), target=join(destination,relative(source,file))
    if (entry.isDirectory()) { mkdirSync(target,{recursive:true}); copyTree(file) }
    else {
      copyFileSync(file,target)
      generatedHashes[relative(source,file).split(sep).join('/')] = createHash('sha256').update(readFileSync(file)).digest('hex')
    }
  }
}
mkdirSync(join(destination,'src'),{recursive:true});copyTree(join(source,'src'))
for (const file of ['package.json','package-lock.json','tsconfig.json','nest-cli.json','Dockerfile','.dockerignore','.nvmrc','railway.json','README.md','.env.example']) {
  copyFileSync(join(source,file),join(destination,file))
}
const pkg = JSON.parse(readFileSync(join(source,'package.json'),'utf8'))
pkg.scripts.build = 'node scripts/receptionist-build.mjs'
writeFileSync(join(destination,'package.json'),JSON.stringify(pkg,null,2)+'\n')
mkdirSync(join(destination,'scripts'),{recursive:true})
for (const file of ['receptionist-build.mjs','receptionist-release-fingerprint.mjs']) {
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)),file),join(destination,'scripts',file))
}
let dockerfile = readFileSync(join(destination,'Dockerfile'),'utf8')
for (const expected of ['COPY tsconfig.json nest-cli.json ./','COPY --chown=node:node package.json release-manifest.json ./']) {
  if (!dockerfile.includes(expected)) throw new Error(`Unrecognised frontdesk Docker contract: ${expected}`)
}
dockerfile = dockerfile.replace('COPY tsconfig.json nest-cli.json ./',
  'COPY tsconfig.json nest-cli.json Dockerfile .dockerignore railway.json .nvmrc release-manifest.json release-schema.json ./\nCOPY scripts ./scripts')
  .replace('COPY --chown=node:node package.json release-manifest.json ./',
    'COPY --from=builder --chown=node:node /app/package.json /app/release-manifest.json /app/build-attestation.json /app/release-schema.json ./')
writeFileSync(join(destination,'Dockerfile'),dockerfile)
writeFileSync(join(destination,'release-schema.json'),JSON.stringify({version:1,
  requiredMigrations:REQUIRED_RECEPTIONIST_MIGRATIONS,migrationHashes:receptionistSchemaHashes(platform)},null,2)+'\n')
const buildInputHashes = Object.fromEntries([
  'package.json','package-lock.json','tsconfig.json','nest-cli.json','Dockerfile','.dockerignore','railway.json','.nvmrc',
  'scripts/receptionist-build.mjs','scripts/receptionist-release-fingerprint.mjs',
  'release-schema.json',
].map((file) => [file,createHash('sha256').update(readFileSync(join(destination,file))).digest('hex')]))
const manifest = {
  contractVersion:2, trade:'front-desk', approvalRequired:true, requiredMigrations:REQUIRED_RECEPTIONIST_MIGRATIONS,
  originCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),
  sourceHash:createHash('sha256').update(JSON.stringify({ generatedHashes, buildInputHashes })).digest('hex'),
  dependencies:pkg.dependencies, generatedHashes, buildInputHashes,
}
writeFileSync(join(destination,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
console.log(`Staged front-desk ${manifest.sourceHash} without secrets or working-copy mutation`)

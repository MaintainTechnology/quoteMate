import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {expect,it} from 'vitest'

const source=readFileSync('scripts/export-receptionist.mjs','utf8')
const templates=runInNewContext(`${source.slice(source.indexOf('const tpl ='),source.indexOf('// ── env template'))};tpl`) as {
  dockerfile:(trade:string)=>string;dockerignore:()=>string
}
it.each(['electrical','plumbing','roofing','painting','solar'])('%s builder can COPY its fingerprinted Docker metadata',trade=>{
  const docker=templates.dockerfile(trade),ignored=templates.dockerignore().trim().split(/\r?\n/)
  expect(docker).toContain('COPY tsconfig.json nest-cli.json Dockerfile .dockerignore railway.json .nvmrc release-manifest.json ./')
  for(const required of ['Dockerfile','.dockerignore','tsconfig.json','nest-cli.json','railway.json','.nvmrc','release-manifest.json']) {
    expect(ignored,`Required COPY source ${required} must be in the build context`).not.toContain(required)
  }
  expect(ignored).toEqual(expect.arrayContaining(['node_modules','dist','.git','.env','.env.*']))
})

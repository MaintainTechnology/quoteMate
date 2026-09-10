import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import {it,expect} from 'vitest'
const source=readFileSync('scripts/export-receptionist.mjs','utf8')
const fn=source.slice(source.indexOf('function stripRetirementGuard('),source.indexOf('// REMOVED, not disabled.',source.indexOf('function stripRetirementGuard(')))
const strip=runInNewContext(`(${fn.trim()})`) as (source:string)=>string
it('removes the current website retirement return while preserving signature validation and durable ingress',()=>{
  const canonical=readFileSync('app/api/sms/inbound/route.ts','utf8')
  const exported=strip(canonical)
  expect(exported).not.toContain('if (!RECEPTIONIST_ENABLED)')
  expect(exported).not.toContain('const RECEPTIONIST_ENABLED')
  expect(exported).toContain('const RETIRED_ACK =')
  expect(exported).toContain('validateTwilioSignature(signature, url, params)')
  expect(exported).toContain('enqueueSmsWork(')
  expect(exported).toContain('if (!currentSmsWork()')
  expect(exported).toContain("try {\n  console.log('[sms/inbound] step 1")
})
it('still accepts the old block shape and rejects an unknown retirement shape',()=>{
  const prefix="// divider\n// RETIRED 2026-08-05\nconst RECEPTIONIST_ENABLED = false\nconst RETIRED_ACK = 'xml'\nexport async function POST(req: Request) {\n"
  expect(strip(prefix+"if (!RECEPTIONIST_ENABLED) {\nreturn new Response(RETIRED_ACK)\n}\nawait enqueueSmsWork({})\n}" )).toContain('await enqueueSmsWork({})')
  expect(()=>strip(prefix+'if (!RECEPTIONIST_ENABLED) throw Error()\n}')).toThrow('guard opener')
})

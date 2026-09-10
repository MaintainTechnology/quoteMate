import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { transpileModule, ModuleKind } from 'typescript'
import { vi, it, expect, afterEach } from 'vitest'

afterEach(()=>vi.useRealTimers())
it('hung turn does not block separate delivery recovery, and guards prevent duplicate local attempts',async()=>{
  vi.useFakeTimers()
  const source=readFileSync('scripts/receptionist-runtime/scheduler.ts.template','utf8')
  const js=transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS}}).outputText
  const module={exports:{} as {startIndependentPollers(work:()=>Promise<unknown>,outbox:()=>Promise<unknown>,ms:number):()=>void}}
  new Function('module','exports','require',js)(module,module.exports,createRequire(import.meta.url))
  const work=vi.fn(()=>new Promise(()=>{})), outbox=vi.fn(async()=>{})
  const stop=module.exports.startIndependentPollers(work,outbox,10)
  await vi.advanceTimersByTimeAsync(100)
  expect(work).toHaveBeenCalledTimes(1)
  expect(outbox).toHaveBeenCalledTimes(10)
  stop();await vi.advanceTimersByTimeAsync(100)
  expect(outbox).toHaveBeenCalledTimes(10)
})

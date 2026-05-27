// Phase 7 — tests for the structured pipeline tracer.
//
// Coverage:
//   • truncateForTrace caps strings + objects + arrays at the byte budget
//   • truncateForTrace preserves small payloads verbatim
//   • recordTrace inserts the right shape via supabase.from('pipeline_traces')
//   • recordTrace SWALLOWS errors (logging must never break the request)
//   • createTracer binds tenant/intake/sms_conversation FKs and forwards them
//   • createTracer per-call partial overrides win over bound context
//   • stopwatch returns sensible elapsed times

import { describe, expect, it, vi } from 'vitest'
import {
  truncateForTrace,
  recordTrace,
  createTracer,
  stopwatch,
} from './trace'

// Minimal Supabase stub — captures the inserted row so tests can assert
// what would have been written. Mirrors the @supabase/supabase-js fluent
// API just enough for recordTrace + createTracer.
function makeSupabaseStub(opts?: { throwOnInsert?: boolean }) {
  const inserted: any[] = []
  const stub = {
    from: (table: string) => ({
      insert: vi.fn(async (row: any) => {
        if (opts?.throwOnInsert) {
          throw new Error('simulated DB failure')
        }
        inserted.push({ table, row })
        return { error: null }
      }),
    }),
  } as any
  return { stub, inserted }
}

describe('truncateForTrace', () => {
  it('passes small payloads through unchanged', () => {
    const v = { hello: 'world', n: 42 }
    expect(truncateForTrace(v)).toEqual(v)
  })

  it('null + undefined unchanged', () => {
    expect(truncateForTrace(null)).toBeNull()
    expect(truncateForTrace(undefined)).toBeUndefined()
  })

  it('truncates large objects to a stub with head retained', () => {
    const big = { huge: 'x'.repeat(20000) }
    const out: any = truncateForTrace(big, 1024)
    expect(out.__truncated).toBe(true)
    expect(out.head).toBeDefined()
    expect(typeof out.head).toBe('string')
    expect(out.head.length).toBeLessThanOrEqual(1024)
  })

  it('truncates large arrays by keeping first 20 items', () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({ idx: i, padding: 'p'.repeat(100) }))
    const out: any = truncateForTrace(arr, 1024)
    expect(out.__truncated).toBe(true)
    expect(out.head).toHaveLength(20)
    expect(out.head[0].idx).toBe(0)
    expect(out.head[19].idx).toBe(19)
  })

  it('handles non-serialisable values (circular ref) gracefully', () => {
    const a: any = { name: 'a' }
    a.self = a
    const out: any = truncateForTrace(a)
    expect(out.__trace_error).toBe('value not JSON-serialisable')
  })

  it('preserves a small array fully', () => {
    const arr = [1, 2, 3]
    expect(truncateForTrace(arr)).toEqual(arr)
  })
})

describe('recordTrace', () => {
  it('inserts the right shape into pipeline_traces', async () => {
    const { stub, inserted } = makeSupabaseStub()
    await recordTrace(stub, {
      step: 'estimate',
      substep: 'recipe_merge',
      status: 'ok',
      message: 'two recipes fired',
      inputs: { intake_id: 'abc' },
      outputs: { added_line_items: 2 },
      decisions: { route: 'auto_quote' },
      duration_ms: 234,
      tenant_id: 't1',
      intake_id: 'i1',
      sms_conversation_id: 's1',
    })
    expect(inserted).toHaveLength(1)
    expect(inserted[0].table).toBe('pipeline_traces')
    expect(inserted[0].row).toMatchObject({
      step: 'estimate',
      substep: 'recipe_merge',
      status: 'ok',
      message: 'two recipes fired',
      duration_ms: 234,
      tenant_id: 't1',
      intake_id: 'i1',
      sms_conversation_id: 's1',
    })
    expect(inserted[0].row.inputs).toEqual({ intake_id: 'abc' })
    expect(inserted[0].row.outputs).toEqual({ added_line_items: 2 })
    expect(inserted[0].row.decisions).toEqual({ route: 'auto_quote' })
  })

  it('normalises missing optional fields to null', async () => {
    const { stub, inserted } = makeSupabaseStub()
    await recordTrace(stub, {
      step: 'sms_inbound',
      status: 'ok',
    })
    expect(inserted[0].row).toMatchObject({
      step: 'sms_inbound',
      status: 'ok',
      substep: null,
      message: undefined, // truncateMessage returns the value as-is when ≤ budget; undefined stays undefined here
      inputs: null,
      outputs: null,
      decisions: null,
      duration_ms: null,
      tenant_id: null,
      intake_id: null,
      sms_conversation_id: null,
    })
  })

  it('rounds and clamps duration_ms', async () => {
    const { stub, inserted } = makeSupabaseStub()
    await recordTrace(stub, {
      step: 'estimate',
      status: 'ok',
      duration_ms: 234.7,
    })
    expect(inserted[0].row.duration_ms).toBe(235)

    inserted.length = 0
    await recordTrace(stub, {
      step: 'estimate',
      status: 'ok',
      duration_ms: -5, // clamps to 0
    })
    expect(inserted[0].row.duration_ms).toBe(0)
  })

  it('NaN duration becomes null (defensive)', async () => {
    const { stub, inserted } = makeSupabaseStub()
    await recordTrace(stub, {
      step: 'estimate',
      status: 'ok',
      duration_ms: Number.NaN,
    })
    expect(inserted[0].row.duration_ms).toBeNull()
  })

  it('SWALLOWS DB errors silently — logging never breaks the route', async () => {
    const { stub } = makeSupabaseStub({ throwOnInsert: true })
    // Must not reject.
    await expect(
      recordTrace(stub, { step: 'estimate', status: 'ok' }),
    ).resolves.toBeUndefined()
  })

  it('null supabase client → no-op (offline / pre-mig deploy)', async () => {
    // Don't crash if the caller hasn't supplied a client.
    await expect(
      recordTrace(null, { step: 'sms_inbound', status: 'ok' }),
    ).resolves.toBeUndefined()
  })

  it('truncates massive inputs/outputs before insert', async () => {
    const { stub, inserted } = makeSupabaseStub()
    await recordTrace(stub, {
      step: 'estimate',
      status: 'ok',
      inputs: { payload: 'x'.repeat(30000) },
    })
    const truncated = inserted[0].row.inputs
    expect(truncated.__truncated).toBe(true)
  })

  it('truncates over-long messages to 500 chars', async () => {
    const { stub, inserted } = makeSupabaseStub()
    await recordTrace(stub, {
      step: 'estimate',
      status: 'err',
      message: 'x'.repeat(800),
    })
    expect(inserted[0].row.message.length).toBeLessThanOrEqual(500)
    expect(inserted[0].row.message.endsWith('…')).toBe(true)
  })
})

describe('createTracer', () => {
  it('binds context and forwards to recordTrace', async () => {
    const { stub, inserted } = makeSupabaseStub()
    const trace = createTracer(stub, {
      tenant_id: 'T',
      intake_id: 'I',
      sms_conversation_id: 'S',
    })
    trace('estimate', 'ok', { substep: 'start', message: 'hello' })
    // The tracer fires recordTrace fire-and-forget. Yield to the event loop
    // so the awaited insert lands before assertion.
    await new Promise((r) => setTimeout(r, 0))
    expect(inserted).toHaveLength(1)
    expect(inserted[0].row).toMatchObject({
      step: 'estimate',
      status: 'ok',
      substep: 'start',
      tenant_id: 'T',
      intake_id: 'I',
      sms_conversation_id: 'S',
    })
  })

  it('per-call partial overrides win over bound context', async () => {
    const { stub, inserted } = makeSupabaseStub()
    const trace = createTracer(stub, { tenant_id: 'T' })
    trace('sms_inbound', 'ok', {
      tenant_id: 'OVERRIDE',
      sms_conversation_id: 'S-CALL',
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(inserted[0].row.tenant_id).toBe('OVERRIDE')
    expect(inserted[0].row.sms_conversation_id).toBe('S-CALL')
  })

  it('null supabase → no-op tracer (no throws)', () => {
    const trace = createTracer(null, {})
    // Must not throw on call.
    expect(() => trace('estimate', 'ok', { message: 'noop' })).not.toThrow()
  })
})

describe('stopwatch', () => {
  it('returns a non-negative elapsed time', async () => {
    const sw = stopwatch()
    await new Promise((r) => setTimeout(r, 10))
    const e = sw.elapsed()
    expect(e).toBeGreaterThanOrEqual(0)
    expect(e).toBeLessThan(5_000)
  })

  it('multiple .elapsed() calls produce monotonically nondecreasing values', async () => {
    const sw = stopwatch()
    const a = sw.elapsed()
    await new Promise((r) => setTimeout(r, 5))
    const b = sw.elapsed()
    expect(b).toBeGreaterThanOrEqual(a)
  })
})

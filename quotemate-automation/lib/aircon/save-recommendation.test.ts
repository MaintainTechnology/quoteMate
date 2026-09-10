// saveAirconRecommendation + supabaseUserIdFor (spec quotes-tab-sync T3,
// hardened per code review): the persist step shared by /api/aircon/recommend
// and /api/aircon/plan. created_by is a uuid → auth.users FK, so a Clerk
// caller ('user_…' string id, not a uuid) must resolve to
// tenant.owner_user_id — the exact trap app/api/roofing/save documents.

import { describe, it, expect } from 'vitest'
import {
  airconIdempotencyToken,
  saveAirconRecommendation,
  supabaseUserIdFor,
} from './save-recommendation'
import type { AcPricedRecommendation } from './types'

const recommendation = {
  pricing_status: 'priced',
  routing: { decision: 'book_assessment', reason: 'indicative only' },
} as unknown as AcPricedRecommendation

const address = { address: '12 Example St, Sydney', postcode: '2000', state: 'NSW' }

function stubClient(result: { data: unknown; error: unknown }) {
  const calls: { table?: string; payload?: Record<string, unknown> } = {}
  const client = {
    from(table: string) {
      calls.table = table
      return {
        insert(payload: Record<string, unknown>) {
          calls.payload = payload
          return { select: () => ({ single: async () => result }) }
        },
      }
    },
  }
  return { client: client as never, calls }
}

function sequenceClient(results: Array<{ data: unknown; error: unknown }>) {
  const operations: string[] = []
  const from = () => {
    const query: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'maybeSingle', 'insert', 'single']) {
      query[op] = () => {
        operations.push(op)
        return query
      }
    }
    query.then = (resolve: (result: { data: unknown; error: unknown }) => unknown) =>
      Promise.resolve(results.shift() ?? { data: null, error: null }).then(resolve)
    return query
  }
  return { client: { from } as never, operations }
}

describe('supabaseUserIdFor', () => {
  it('Clerk caller resolves to the tenant owner uuid, never the user_… string', () => {
    expect(
      supabaseUserIdFor(
        { provider: 'clerk', userId: 'user_2abc' },
        { owner_user_id: 'b0000000-0000-4000-8000-000000000001' },
      ),
    ).toBe('b0000000-0000-4000-8000-000000000001')
  })

  it('Clerk caller with no owner link resolves to null', () => {
    expect(supabaseUserIdFor({ provider: 'clerk', userId: 'user_2abc' }, { owner_user_id: null })).toBeNull()
    expect(supabaseUserIdFor({ provider: 'clerk', userId: 'user_2abc' }, null)).toBeNull()
  })

  it('legacy Supabase caller uses their own auth id when the tenant has no owner link', () => {
    expect(
      supabaseUserIdFor(
        { provider: 'supabase', userId: 'c0000000-0000-4000-8000-000000000002' },
        { owner_user_id: null },
      ),
    ).toBe('c0000000-0000-4000-8000-000000000002')
  })
})

describe('saveAirconRecommendation', () => {
  it('no tenant → no insert, returns null', async () => {
    const { client, calls } = stubClient({ data: { id: 'x' }, error: null })
    const saved = await saveAirconRecommendation(client, {
      tenantId: null,
      createdBy: null,
      address,
      recommendation,
    })
    expect(saved).toBeNull()
    expect(calls.table).toBeUndefined()
  })

  it('persists the full row and returns id + public_token', async () => {
    const { client, calls } = stubClient({ data: { id: 'rec-1' }, error: null })
    const saved = await saveAirconRecommendation(client, {
      tenantId: 'tenant-1',
      createdBy: 'b0000000-0000-4000-8000-000000000001',
      address,
      recommendation,
    })
    expect(saved?.id).toBe('rec-1')
    expect(typeof saved?.public_token).toBe('string')
    expect(saved!.public_token.length).toBeGreaterThan(10)
    expect(calls.table).toBe('aircon_recommendations')
    expect(calls.payload).toMatchObject({
      tenant_id: 'tenant-1',
      created_by: 'b0000000-0000-4000-8000-000000000001',
      address: '12 Example St, Sydney',
      postcode: '2000',
      state: 'NSW',
      routing: 'book_assessment',
      public_token: saved!.public_token,
    })
    expect(calls.payload!.recommendation).toBe(recommendation)
    expect((calls.payload!.recommendation as AcPricedRecommendation).pricing_status).toBe('priced')
  })

  it('insert failure is swallowed (best-effort) and returns null', async () => {
    const { client } = stubClient({ data: null, error: { message: 'boom' } })
    const saved = await saveAirconRecommendation(client, {
      tenantId: 'tenant-1',
      createdBy: null,
      address,
      recommendation,
    })
    expect(saved).toBeNull()
  })

  it('returns null before I/O when a retry id cannot be bound to a server secret', async () => {
    const { client, operations } = sequenceClient([])
    const saved = await saveAirconRecommendation(client, {
      tenantId: 'tenant-1',
      createdBy: null,
      address,
      recommendation,
      requestId: 'ac_request_1234',
    })
    expect(saved).toBeNull()
    expect(operations).toEqual([])
  })

  it('repeated taps/refetch return the same tenant-bound persisted row without inserting', async () => {
    const token = airconIdempotencyToken({
      tenantId: 'tenant-1',
      requestId: 'ac_request_1234',
      secret: 'test-secret',
    })
    expect(token).toBe(
      airconIdempotencyToken({
        tenantId: 'tenant-1',
        requestId: 'ac_request_1234',
        secret: 'test-secret',
      }),
    )
    expect(token).not.toBe(
      airconIdempotencyToken({
        tenantId: 'tenant-2',
        requestId: 'ac_request_1234',
        secret: 'test-secret',
      }),
    )
    const { client, operations } = sequenceClient([
      { data: { id: 'rec-existing', public_token: token, recommendation }, error: null },
    ])
    await expect(
      saveAirconRecommendation(client, {
        tenantId: 'tenant-1',
        createdBy: null,
        address,
        recommendation,
        requestId: 'ac_request_1234',
        idempotencySecret: 'test-secret',
      }),
    ).resolves.toEqual({ id: 'rec-existing', public_token: token, recommendation })
    expect(operations).not.toContain('insert')
  })

  it('resolves the winner when a concurrent retry wins the insert race', async () => {
    const token = airconIdempotencyToken({
      tenantId: 'tenant-1',
      requestId: 'ac_request_1234',
      secret: 'test-secret',
    })
    const { client } = sequenceClient([
      { data: null, error: null },
      { data: null, error: { message: 'duplicate' } },
      { data: { id: 'rec-winner', public_token: token, recommendation }, error: null },
    ])
    await expect(
      saveAirconRecommendation(client, {
        tenantId: 'tenant-1',
        createdBy: null,
        address,
        recommendation,
        requestId: 'ac_request_1234',
        idempotencySecret: 'test-secret',
      }),
    ).resolves.toEqual({ id: 'rec-winner', public_token: token, recommendation })
  })
})

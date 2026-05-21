import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isAdminUser } from './auth'

// Minimal fake of the supabase query chain isAdminUser uses:
//   supabase.from(...).select(...).eq(...).maybeSingle()
function fakeClient(result: { data: unknown; error: unknown }): SupabaseClient {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  }
  return { from: () => chain } as unknown as SupabaseClient
}

function throwingClient(): SupabaseClient {
  return {
    from: () => {
      throw new Error('connection lost')
    },
  } as unknown as SupabaseClient
}

describe('isAdminUser', () => {
  it('is true when the user has an admin_users row', async () => {
    const client = fakeClient({ data: { user_id: 'u1' }, error: null })
    expect(await isAdminUser(client, 'u1')).toBe(true)
  })

  it('is false when the user has no admin_users row', async () => {
    const client = fakeClient({ data: null, error: null })
    expect(await isAdminUser(client, 'u1')).toBe(false)
  })

  it('fails closed on a missing/blank user id without touching the DB', async () => {
    const client = fakeClient({ data: { user_id: 'x' }, error: null })
    expect(await isAdminUser(client, null)).toBe(false)
    expect(await isAdminUser(client, undefined)).toBe(false)
    expect(await isAdminUser(client, '')).toBe(false)
  })

  it('fails closed on a DB error', async () => {
    const client = fakeClient({ data: null, error: { message: 'rls denied' } })
    expect(await isAdminUser(client, 'u1')).toBe(false)
  })

  it('fails closed when the query throws', async () => {
    expect(await isAdminUser(throwingClient(), 'u1')).toBe(false)
  })
})

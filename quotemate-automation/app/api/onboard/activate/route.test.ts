import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  type Identity = {
    provider: 'clerk' | 'supabase'
    userId: string
    email: string | null
  }
  const state = {
    identity: { provider: 'clerk', userId: 'user_authenticated', email: null } as Identity | null,
    existing: null as Record<string, unknown> | null,
    existingError: null as { message: string } | null,
    stopAfterTenantInsert: false,
    tenantInsertPayloads: [] as Array<Record<string, unknown>>,
    fromCalls: [] as string[],
    eqCalls: [] as Array<[string, unknown]>,
  }

  const from = vi.fn((table: string) => {
    state.fromCalls.push(table)
    if (table === 'pricing_book' && state.stopAfterTenantInsert) {
      return {
        insert: vi.fn(async () => ({ error: { message: 'forced pricing stop' } })),
      }
    }
    const builder: Record<string, unknown> = {}
    builder.select = vi.fn(() => builder)
    builder.insert = vi.fn((payload: Record<string, unknown>) => {
      if (table === 'tenants') state.tenantInsertPayloads.push(payload)
      return builder
    })
    builder.delete = vi.fn(() => builder)
    builder.eq = vi.fn((column: string, value: unknown) => {
      state.eqCalls.push([column, value])
      return builder
    })
    builder.maybeSingle = vi.fn(async () => ({
      data: state.existing,
      error: state.existingError,
    }))
    builder.single = vi.fn(async () => ({ data: { id: 'tenant-new' }, error: null }))
    return builder
  })

  const resolveIdentityRequest = vi.fn(async (_supabase: unknown, req: Request) => {
    return req.headers.get('authorization') === 'Bearer valid-token' ? state.identity : null
  })
  const checkInvitationCode = vi.fn()
  const consumeInvitationCode = vi.fn()
  const runProvisioning = vi.fn()
  const inspectIntentToken = vi.fn()

  return {
    state,
    client: { from },
    from,
    resolveIdentityRequest,
    checkInvitationCode,
    consumeInvitationCode,
    runProvisioning,
    inspectIntentToken,
  }
})

vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }))
vi.mock('@/lib/tenant/from-request', () => ({
  resolveIdentityRequest: h.resolveIdentityRequest,
}))
vi.mock('@/lib/onboard/invitation-codes', () => ({
  checkInvitationCode: h.checkInvitationCode,
  consumeInvitationCode: h.consumeInvitationCode,
}))
vi.mock('@/lib/onboard/run-provisioning', () => ({ runProvisioning: h.runProvisioning }))
vi.mock('@/lib/onboard/intent-tokens', () => ({
  inspectIntentToken: h.inspectIntentToken,
  markIntentUsed: vi.fn(),
}))
vi.mock('@/lib/onboard/seed-tenant-defaults', () => ({
  seedTenantServiceOfferings: vi.fn(),
}))
vi.mock('@/lib/features/access', () => ({ stampFeatureProvenance: vi.fn() }))
vi.mock('@/lib/clerk/ensure-user', () => ({ ensureClerkUser: vi.fn() }))
vi.mock('@/lib/videos/trust-video', () => ({ autoGenerateTrustVideos: vi.fn() }))
vi.mock('next/server', () => ({ after: vi.fn() }))

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role'

const { POST } = await import('./route')

const validBody = (overrides: Record<string, unknown> = {}) => ({
  business_name: 'Authenticated Electrical',
  owner_first_name: 'Alex',
  owner_email: 'alex@example.com',
  trades: ['painting'],
  invitation_code: 'INVITE-1',
  ...overrides,
})

const request = (body: Record<string, unknown>, bearer = true) =>
  new Request('http://test/api/onboard/activate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: 'Bearer valid-token' } : {}),
    },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  h.state.identity = { provider: 'clerk', userId: 'user_authenticated', email: null }
  h.state.existing = null
  h.state.existingError = null
  h.state.stopAfterTenantInsert = false
  h.state.tenantInsertPayloads = []
  h.state.fromCalls = []
  h.state.eqCalls = []
  h.resolveIdentityRequest.mockClear()
  h.checkInvitationCode.mockClear()
  h.checkInvitationCode.mockResolvedValue({ ok: true, code_id: 'code-1' })
  h.consumeInvitationCode.mockReset()
  h.consumeInvitationCode.mockResolvedValue({ ok: true })
  h.runProvisioning.mockClear()
  h.inspectIntentToken.mockReset()
  h.inspectIntentToken.mockResolvedValue({
    status: 'verified',
    intent: { owner_mobile: '+61412345678' },
  })
})

describe('POST /api/onboard/activate authentication and idempotency', () => {
  it('requires a bearer before parsing or making service-role queries', async () => {
    const res = await POST(request(validBody(), false))

    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ ok: false, error: 'unauthorized' })
    expect(h.state.fromCalls).toEqual([])
    expect(h.checkInvitationCode).not.toHaveBeenCalled()
  })

  it('rejects a mismatched client Clerk id before any service-role query', async () => {
    const res = await POST(request(validBody({ clerk_user_id: 'user_victim' })))

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'identity_mismatch',
      fieldErrors: { clerk_user_id: expect.any(Array) },
    })
    expect(h.state.fromCalls).toEqual([])
  })

  it('rejects a caller-supplied legacy owner id on a Clerk activation', async () => {
    const res = await POST(
      request(
        validBody({ owner_user_id: '11111111-1111-4111-8111-111111111111' }),
      ),
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({
      ok: false,
      error: 'identity_mismatch',
      fieldErrors: { owner_user_id: expect.any(Array) },
    })
    expect(h.state.fromCalls).toEqual([])
  })

  it.each(['expired', 'used', 'invalid'] as const)(
    'rejects an %s SMS intent before invitation or tenant writes',
    async status => {
      h.inspectIntentToken.mockResolvedValue({ status })

      const res = await POST(request(validBody({ intent_token: 'abc123' })))

      expect(res.status).toBe(422)
      await expect(res.json()).resolves.toMatchObject({ ok: false, error: `intent_${status}` })
      expect(h.checkInvitationCode).not.toHaveBeenCalled()
      expect(h.state.tenantInsertPayloads).toEqual([])
    },
  )

  it('derives the tenant mobile from the verified intent when the client omits it', async () => {
    h.state.stopAfterTenantInsert = true

    const res = await POST(request(validBody({ intent_token: 'abc123' })))

    expect(res.status).toBe(500)
    expect(h.state.tenantInsertPayloads).toHaveLength(1)
    expect(h.state.tenantInsertPayloads[0]).toMatchObject({
      owner_mobile: '+61412345678',
      clerk_user_id: 'user_authenticated',
    })
  })

  it('rejects a caller-supplied phone that disagrees with the verified intent', async () => {
    const res = await POST(
      request(
        validBody({ intent_token: 'abc123', owner_mobile: '+61499999999' }),
      ),
    )

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: 'intent_mobile_mismatch',
    })
    expect(h.checkInvitationCode).not.toHaveBeenCalled()
    expect(h.state.tenantInsertPayloads).toEqual([])
  })

  it.each(['code_paused', 'code_revoked', 'quota_exhausted'])(
    'rechecks a changed invitation at activation and returns %s before writes',
    async error => {
      h.checkInvitationCode.mockResolvedValue({
        ok: false,
        error,
        message: 'Invitation is no longer available.',
      })

      const res = await POST(request(validBody()))

      expect(res.status).toBe(422)
      await expect(res.json()).resolves.toMatchObject({ ok: false, error })
      expect(h.state.tenantInsertPayloads).toEqual([])
    },
  )

  it('returns the same authenticated tenant on repeat without provisioning again', async () => {
    h.state.existing = {
      id: 'tenant-existing',
      status: 'active',
      twilio_sms_number: '+61412345678',
      vapi_assistant_id: 'assistant_real',
    }

    const first = await POST(request(validBody()))
    const second = await POST(request(validBody({ clerk_user_id: 'user_authenticated' })))

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      tenantId: 'tenant-existing',
      alreadyActivated: true,
      setupComplete: false,
      idempotent: true,
    })
    await expect(second.json()).resolves.toMatchObject({
      tenantId: 'tenant-existing',
      idempotent: true,
    })
    expect(h.state.eqCalls).toEqual([
      ['clerk_user_id', 'user_authenticated'],
      ['tenant_id', 'tenant-existing'],
      ['clerk_user_id', 'user_authenticated'],
      ['tenant_id', 'tenant-existing'],
    ])
    expect(h.checkInvitationCode).not.toHaveBeenCalled()
    expect(h.consumeInvitationCode).not.toHaveBeenCalled()
    expect(h.runProvisioning).not.toHaveBeenCalled()
  })

  it('writes the verified Clerk subject when a new client sends no ownership ids', async () => {
    h.state.stopAfterTenantInsert = true

    const res = await POST(request(validBody()))

    // The forced pricing failure stops before service seeding/provisioning; the
    // assertion is specifically on the service-role tenant insert boundary.
    expect(res.status).toBe(500)
    expect(h.state.tenantInsertPayloads).toHaveLength(1)
    expect(h.state.tenantInsertPayloads[0]).toMatchObject({
      owner_user_id: null,
      clerk_user_id: 'user_authenticated',
    })
    expect(h.state.tenantInsertPayloads[0]).not.toHaveProperty('clerk_user_id', 'user_victim')
    expect(h.runProvisioning).not.toHaveBeenCalled()
  })
})

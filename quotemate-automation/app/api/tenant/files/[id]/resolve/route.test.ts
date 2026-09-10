import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), admin: vi.fn(), from: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: mocks.from }) }))
vi.mock('@/lib/tenant/from-request', () => ({ resolveTenantRequest: mocks.tenant }))
vi.mock('@/lib/admin-loader/route-auth', () => ({ resolveAdminUserId: mocks.admin }))
// Exercise both handlers through the actual ownership and persistence helpers.
import { POST } from './route'
import { POST as adminPost } from '@/app/api/admin/files/[id]/resolve/route'

const FILE_ID = '00000000-0000-0000-0000-000000000001'
const ctx = { params: Promise.resolve({ id: FILE_ID }) }
const request = (body: string) => new Request(`https://example.test/api/tenant/files/${FILE_ID}/resolve`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body,
})
let doc: { id: string; tenant_id: string; comments_resolved_at: null; comments_resolved_by: null } | null
let writeError: unknown
let writeMissing: boolean
let writeRejects: boolean
let queries: Array<{ table: string; filters: Array<[string, unknown]>; patch?: Record<string, unknown> }>

function query(table: string) {
  const call: typeof queries[number] = { table, filters: [] }
  queries.push(call)
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => { call.filters.push([column, value]); return builder },
    update: (patch: Record<string, unknown>) => { call.patch = patch; return builder },
    maybeSingle: async () => {
      if (call.patch) {
        if (writeRejects) throw new Error('connection failed')
        return { data: writeMissing ? null : call.patch, error: writeError }
      }
      return { data: table === 'tenant_file_documents' ? doc : { business_name: 'Test Electrical' }, error: null }
    },
  }
  return builder
}

beforeEach(() => {
  vi.clearAllMocks()
  doc = { id: FILE_ID, tenant_id: 'tenant-a', comments_resolved_at: null, comments_resolved_by: null }
  writeError = null; writeMissing = false; writeRejects = false; queries = []
  mocks.from.mockImplementation(query)
  mocks.tenant.mockResolvedValue({ tenant: { id: 'tenant-a', owner_user_id: 'user-a' }, identity: { userId: 'user-a' } })
  mocks.admin.mockResolvedValue('admin-a')
})

describe('file-thread resolution action and database boundaries', () => {
  it.each([true, false])('persists the owned file thread to literal %s and returns acknowledged state', async (resolved) => {
    const response = await POST(request(JSON.stringify({ resolved })), ctx)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true, resolved, resolved_at: resolved ? expect.any(String) : null, resolved_by: resolved ? 'tenant' : null })
    const write = queries.find((call) => call.patch)
    expect(write).toEqual({ table: 'tenant_file_documents', filters: [['id', FILE_ID], ['tenant_id', 'tenant-a']],
      patch: { comments_resolved_at: body.resolved_at, comments_resolved_by: body.resolved_by } })
  })

  it.each(['{', '', 'null', '[]', 'false', '{}', '{"resolved":"false"}', '{"resolved":1}', '{"resolved":0}', '{"resolved":null}'])(
    'rejects malformed or non-boolean payload %s without mutation', async (body) => {
      expect((await POST(request(body), ctx)).status).toBe(400)
      expect(queries.some((call) => call.patch)).toBe(false)
    },
  )

  it('retains auth before parse or file lookup', async () => {
    mocks.tenant.mockResolvedValue(null)
    expect((await POST(request('{'), ctx)).status).toBe(401)
    expect(queries).toHaveLength(0)
  })

  it.each([null, 'tenant-b'])('retains missing/foreign ownership guard for %s', async (tenantId) => {
    doc = tenantId ? { ...doc!, tenant_id: tenantId } : null
    expect((await POST(request('{"resolved":true}'), ctx)).status).toBe(404)
    expect(queries.some((call) => call.patch)).toBe(false)
  })

  it.each([true, false])('does not claim success for failed resolved=%s writes', async (resolved) => {
    writeError = { message: 'private database details' }
    const response = await POST(request(JSON.stringify({ resolved })), ctx)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'thread_resolution_failed' })
  })

  it.each([true, false])('does not claim success when resolved=%s updates no owned row', async (resolved) => {
    writeMissing = true
    const response = await POST(request(JSON.stringify({ resolved })), ctx)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  })

  it('returns a retryable error for a rejected database request', async () => {
    writeRejects = true
    const response = await POST(request('{"resolved":true}'), ctx)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'thread_resolution_failed' })
  })

  it('retains the shared admin caller and pins its write to the inspected tenant', async () => {
    const response = await adminPost(request('{"resolved":true}'), ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, resolved: true, resolved_by: 'admin' })
    expect(queries.find((call) => call.patch)?.filters).toEqual([['id', FILE_ID], ['tenant_id', 'tenant-a']])
  })

  it.each(['error', 'missing'])('propagates shared helper %s through the admin caller', async (outcome) => {
    writeError = outcome === 'error' ? { message: 'write failed' } : null
    writeMissing = outcome === 'missing'
    const response = await adminPost(request('{"resolved":false}'), ctx)
    expect(response.status).toBe(outcome === 'error' ? 503 : 404)
    expect(await response.json()).not.toHaveProperty('ok', true)
  })
})

// Tests for POST /api/quote/[id]/document — the owner-gated, money-free write of
// the quote document (report_doc) + per-quote branding (report_style). Verifies:
// the owner-gate + paid/inspection guards, no_changes/invalid_style rejection,
// server-side ReportDoc sanitisation, and that the PDF cache is invalidated.
// Mirrors the supabase mock shape from the /edit route test.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('@/lib/quote/job-quote-operation', () => ({ readQuoteDraftReadiness: vi.fn(async () => ({ ready: true })) }))

type Row = unknown
const state: { user: { id: string } | null; userErr: unknown; quote: Row; tenant: Row; updErr: unknown; readErr?: unknown; raceOnSave?: boolean } = {
  user: null,
  userErr: null,
  quote: undefined,
  tenant: undefined,
  updErr: null,
}
const captured: { update: Record<string, unknown> | null } = { update: null }

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: state.user }, error: state.userErr }) },
    from: (table: string) => {
      const data = table === 'quotes' ? state.quote : table === 'tenants' ? state.tenant : null
      const builder: Record<string, unknown> = {}
      const chain = () => builder
      builder.select = chain
      const filters: Record<string, unknown> = {}
      let update: Record<string, unknown> | null = null
      builder.eq = (key: string, value: unknown) => { filters[key] = value; return builder }
      builder.is = builder.eq
      builder.maybeSingle = async () => {
        if (!update) return { data: structuredClone(data), error: table === 'quotes' ? state.readErr : null }
        if (state.raceOnSave) (state.quote as Record<string, unknown>).paid_at = 'paid'
        if (state.updErr) return { data: null, error: state.updErr }
        const current = state.quote as Record<string, unknown>
        if (!current || Object.entries(filters).some(([key, value]) => {
          const actual = current[key] ?? null
          return actual && typeof actual === 'object' ? JSON.stringify(actual) !== value : actual !== value
        })) return { data: null, error: null }
        captured.update = update
        state.quote = { ...current, ...structuredClone(update) }
        return { data: structuredClone(state.quote), error: null }
      }
      builder.update = (body: Record<string, unknown>) => { update = body; return builder }
      return builder
    },
  }),
}))

import { POST } from './route'
import { quoteEditRevision } from '@/lib/quote/edit-authority'
import { readQuoteDraftReadiness } from '@/lib/quote/job-quote-operation'

function post(body: unknown, opts: { bearer?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.bearer !== false) headers.authorization = 'Bearer tok'
  return POST(new Request('http://x/api/quote/q1/document', { method: 'POST', headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'q1' }),
  })
}

beforeEach(() => {
  vi.stubEnv('FULL_QUOTE_DOC', 'true')
  state.user = { id: 'owner-1' }
  state.userErr = null
  state.quote = { id: 'q1', tenant_id: 't1', paid_at: null, needs_inspection: false }
  state.tenant = { id: 't1', owner_user_id: 'owner-1' }
  state.updErr = null
  state.readErr = null
  state.raceOnSave = false
  captured.update = null
})
afterEach(() => vi.unstubAllEnvs())

const doc = { version: 1, blocks: [{ type: 'title', content: [{ text: 'Hi' }] }, { type: 'pricing' }] }

describe('POST /api/quote/[id]/document — auth & guards', () => {
  it.each(['quote_draft_processing', 'quote_draft_unconfirmed'] as const)('blocks %s before document write', async code => {
    vi.mocked(readQuoteDraftReadiness).mockResolvedValueOnce({ ready: false, code })
    expect(await (await post({ report_doc: doc })).json()).toMatchObject({ error: code })
    expect(captured.update).toBeNull()
  })
  it('401 without a bearer token', async () => {
    const res = await post({ report_doc: doc }, { bearer: false })
    expect(res.status).toBe(401)
  })

  it('401 when the token resolves to no user', async () => {
    state.user = null
    expect((await post({ report_doc: doc })).status).toBe(401)
  })

  it('403 not_owner when the tenant owner differs', async () => {
    // New model: the caller resolves to their OWN tenant (a different tenant than
    // the quote's t1), so quote.tenant_id !== resolved tenant id → not_owner.
    state.tenant = { id: 'other-tenant', owner_user_id: 'owner-1' }
    const res = await post({ report_doc: doc })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'not_owner' })
  })

  it('409 on a paid quote (immutable)', async () => {
    state.quote = { id: 'q1', tenant_id: 't1', paid_at: '2026-07-01', needs_inspection: false }
    expect((await post({ report_doc: doc })).status).toBe(409)
  })

  it('409 on an inspection-routed quote', async () => {
    state.quote = { id: 'q1', tenant_id: 't1', paid_at: null, needs_inspection: true }
    expect((await post({ report_doc: doc })).status).toBe(409)
  })

  it('404 when the quote is missing', async () => {
    state.quote = null
    expect((await post({ report_doc: doc })).status).toBe(404)
  })
})

describe('POST /api/quote/[id]/document — body handling', () => {
  it('400 no_changes when neither field is present', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'no_changes' })
  })

  it('400 invalid_style for an off-list branding value', async () => {
    const res = await post({ report_style: { accentColor: '#123456' } })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_style' })
  })

  it('persists an exact valid document and invalidates the PDF cache', async () => {
    const document = {
      version: 1,
      blocks: [
        { type: 'title', content: [{ text: 'Clean' }] },
        { type: 'pricing' },
        { type: 'paragraph', content: [{ text: 'x', marks: ['bold'] }] },
      ],
    }
    const res = await post({ report_doc: document })
    expect(res.status).toBe(200)
    expect(captured.update).toMatchObject({ pdf_path: null, pdf_signature: null })
    expect(captured.update?.report_doc).toEqual(document)
  })

  it.each([undefined, 'false', 'TRUE'])('blocks document writes with rollout flag %s', async flag => {
    vi.stubEnv('FULL_QUOTE_DOC', flag)
    const response = await post({ report_doc: doc })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'document_editor_disabled' })
    expect(captured.update).toBeNull()
  })

  it.each([
    { version: 1, blocks: [] },
    { version: 1, blocks: [{ type: 'pricing' }, { type: 'pricing' }] },
    { version: 1, blocks: [{ type: 'pricing', total: 50 }] },
    { version: 1, blocks: [{ type: 'pricing' }, { type: 'image' }] },
    { version: 1, blocks: [{ type: 'pricing' }, { type: 'paragraph', content: [{ text: 'x', marks: ['evil'] }] }] },
    { version: 1, blocks: [{ type: 'pricing' }, { type: 'paragraph', content: [{ text: 'x'.repeat(5001) }] }] },
    { version: 1, blocks: [{ type: 'pricing' }, ...Array.from({ length: 300 }, () => ({ type: 'paragraph', content: [] }))] },
    { version: 2, blocks: [{ type: 'pricing' }] },
  ])('rejects invalid or oversized narrative without clipping or saving', async document => {
    const response = await post({ report_doc: document })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: 'invalid_document' })
    expect(captured.update).toBeNull()
  })

  it.each(['branding/another-tenant/logo.png', 'branding/t1/..', 'branding/t1/.'])('rejects unowned or traversal logo %s', async logoPath => {
    expect((await post({ report_style: { logoPath } })).status).toBe(400)
    expect(captured.update).toBeNull()
  })
  it('accepts an owned branding logo', async () => {
    expect((await post({ report_style: { logoPath: 'branding/t1/logo.png' } })).status).toBe(200)
    expect(captured.update?.report_style).toEqual({ logoPath: 'branding/t1/logo.png' })
  })

  it('stores a valid report_style and allows clearing it with null', async () => {
    await post({ report_style: { fontFamily: 'serif' } })
    expect(captured.update?.report_style).toEqual({ fontFamily: 'serif' })

    await post({ report_style: null })
    expect(captured.update?.report_style).toBeNull()
  })
})

describe('POST document — acknowledged conditional persistence', () => {
  it('rejects a payment arriving between read and save without changing the document', async () => {
    state.raceOnSave = true
    const response = await post({ report_doc: doc })
    expect(response.status).toBe(409)
    expect(captured.update).toBeNull()
  })
  it('does not mask read failures as missing quotes', async () => {
    state.readErr = { message: 'database offline' }
    expect((await post({ report_doc: doc })).status).toBe(503)
    expect(captured.update).toBeNull()
  })
  it('does not claim success for a failed write', async () => {
    state.updErr = { message: 'write failed' }
    expect((await post({ report_doc: doc })).status).toBe(500)
    expect(captured.update).toBeNull()
  })
  it('rejects a stale editor revision', async () => {
    expect((await post({ report_doc: doc, expected_revision: 'a'.repeat(64) })).status).toBe(409)
    expect(captured.update).toBeNull()
  })
  it('returns the saved revision and only writes document/style/cache fields', async () => {
    const response = await post({ report_doc: doc, expected_revision: quoteEditRevision(state.quote as Record<string, unknown>) })
    expect(await response.json()).toMatchObject({ persisted: true, edit_revision: quoteEditRevision(state.quote as Record<string, unknown>) })
    expect(Object.keys(captured.update!).sort()).toEqual(['pdf_path', 'pdf_signature', 'report_doc'])
  })
})

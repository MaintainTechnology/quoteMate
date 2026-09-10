import { createClient } from '@supabase/supabase-js'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { quoteEditRevision, validExpectedRevision } from '@/lib/quote/edit-authority'
import { knownQuoteDeleteReason } from '@/lib/quote/delete-authority'
import {
  isOwnedQuoteId, loadOwnedQuoteDetail, ownedQuoteChildPage, OwnedQuoteReadError,
  type OwnedQuoteTenant,
} from '@/lib/quote/owned-detail'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/** Direct owner read for native review/edit; unrelated tenant and legacy unscoped rows stay hidden. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const resolved = await resolveTenantRequest(supabase, req,
      'id,stripe_connect_account_id,stripe_connect_charges_enabled,stripe_connect_payouts_enabled')
    if (!resolved) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    const { id } = await params
    const tenant = resolved.tenant as OwnedQuoteTenant | null
    if (!tenant?.id || !isOwnedQuoteId(id)) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
    const quoteId = id.toLowerCase()
    const detail = await loadOwnedQuoteDetail(supabase, tenant, quoteId, ownedQuoteChildPage(new URL(req.url), quoteId))
    if (!detail) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
    return Response.json(detail, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    const status = error instanceof OwnedQuoteReadError ? error.status : 503
    const code = error instanceof OwnedQuoteReadError ? error.code : 'quote_unavailable'
    return Response.json({ ok: false, error: code }, { status })
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolved = await resolveTenantRequest(supabase, req, 'id')
    if (!resolved) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
    const tenant = resolved.tenant as { id: string } | null
    const { id } = await params
    if (!tenant?.id || !isOwnedQuoteId(id)) return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
    const quoteId = id.toLowerCase()
    let expectedRevision: unknown
    try {
      const raw = await req.text()
      const body: unknown = raw ? JSON.parse(raw) : {}
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
      expectedRevision = (body as Record<string, unknown>).expected_revision
      if (!validExpectedRevision(expectedRevision)) throw new Error()
    } catch { return Response.json({ ok: false, error: 'invalid_body' }, { status: 400 }) }
    // The full server-only snapshot is passed to an atomic compare-and-delete;
    // it is never returned to the client. A late edit/payment/link retains the row.
    const { data: quote, error: readError } = await supabase.from('quotes').select('*')
      .eq('id', quoteId).eq('tenant_id', tenant.id).maybeSingle()
    if (readError) return Response.json({ ok: false, error: 'quote_delete_unavailable' }, { status: 503 })
    if (!quote || quote.id !== quoteId || quote.tenant_id !== tenant.id) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
    }
    if (expectedRevision !== undefined && quoteEditRevision(quote) !== expectedRevision) {
      return Response.json({ ok: false, error: 'quote_changed' }, { status: 409 })
    }
    // No best-effort checkout expiry or saved-job unlink: every shared/payable
    // or linked record is protected by the same SQL guard exposed by owned GET.
    const { data, error } = await supabase.rpc('delete_supported_quote', {
      p_tenant_id: tenant.id, p_quote_id: quoteId, p_expected_quote: quote,
    })
    if (error) return Response.json({ ok: false, error: 'quote_delete_unavailable' }, { status: 503 })
    if (data?.ok === true && data.deleted === true && data.quote_id === quoteId) {
      return Response.json({ ok: true, deleted: true, quote_id: quoteId })
    }
    if (data?.ok === false && knownQuoteDeleteReason(data.error)) {
      return Response.json({ ok: false, error: data.error }, { status: data.error === 'not_found' ? 404 : 409 })
    }
    return Response.json({ ok: false, error: 'quote_delete_unavailable' }, { status: 503 })
  } catch {
    return Response.json({ ok: false, error: 'quote_delete_unavailable' }, { status: 503 })
  }
}

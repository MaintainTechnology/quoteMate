// GET /api/q/paint/[token]/pdf — download the residential painting quote
// PDF. Token = painting_measurements.public_token. Lazy-generates via
// Gotenberg on first hit and streams from the private quote-pdfs bucket so
// the link is stable. Inspection-routed jobs return 404 (no committable
// price belongs in a final-looking document). Mirrors the roof/solar routes.

import { after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { ensurePaintingPdf, downloadQuotePdf } from '@/lib/quote/pdf'
import { archiveQuoteOnDownload } from '@/lib/filestore/archive-on-download'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { isQuotePageOwner } from '@/lib/quote/page-owner'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60 // lazy Gotenberg render on a cold link

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  const { data: row, error: readError } = await supabase
    .from('painting_measurements')
    .select('public_token, tenant_id, released_at, pdf_path, routing')
    .eq('public_token', token)
    .maybeSingle()

  if (readError) return Response.json({ ok: false, error: 'Quote temporarily unavailable' }, { status: 503 })
  if (!row) {
    return Response.json({ ok: false, error: 'Invalid or expired link' }, { status: 404 })
  }
  if (!row.released_at) {
    const owner = await resolveTenantRequest(supabase, req, 'id')
    const owned = Boolean(row.tenant_id) && (owner?.tenant?.id === row.tenant_id || await isQuotePageOwner(supabase, row.tenant_id))
    if (!owned) return Response.json({ ok: false, error: 'Quote awaiting tradie review' }, { status: 409 })
  }
  if (row.routing === 'inspection_required') {
    return Response.json(
      { ok: false, error: 'This job needs an on-site measure first — no PDF until the price is confirmed' },
      { status: 404 },
    )
  }

  // ALWAYS delegate — ensurePaintingPdf owns cached-vs-regenerate via the
  // PAINT_PDF_REV path marker, so PDFs cached by an older template era
  // self-heal on the next download (a row.pdf_path pre-check bypassed that).
  const path = await ensurePaintingPdf(token)
  if (!path) {
    return Response.json({ ok: false, error: 'PDF unavailable right now — try again shortly' }, { status: 503 })
  }

  let pdf: Buffer
  try {
    pdf = await downloadQuotePdf(path)
  } catch (e) {
    console.error('[q/paint/pdf] storage download failed', e instanceof Error ? e.message : e)
    return Response.json({ ok: false, error: 'PDF unavailable' }, { status: 500 })
  }

  // Land this document in the tradie's Files tab (best-effort, post-response).
  after(() => archiveQuoteOnDownload({ sourceKind: 'quote', sourceId: token, trade: 'painting' }))

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="painting-quote-${token.slice(0, 8)}.pdf"`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}

// GET /api/q/roof/[token]/pdf — download the roofing quote PDF.
// Token = roofing_measurements.public_token (same trust model as
// /q/roof/[token]). Lazy-generates via Gotenberg on first hit and streams
// from the private quote-pdfs bucket so the SMS'd link is stable.

import { after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { ensureRoofQuotePdf, downloadQuotePdf } from '@/lib/quote/pdf'
import { archiveQuoteOnDownload } from '@/lib/filestore/archive-on-download'
import { partitionRoofQuote, resolveEffectiveIndices } from '@/lib/roofing/selection'
import { approvedRoofPromotion } from '@/lib/roofing/approved-promotion'
import type { MultiRoofQuote } from '@/lib/roofing/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  const { data: row, error } = await supabase
    .from('roofing_measurements')
    .select(
      'tenant_id, public_token, pdf_path, routing, quote, included_indices, confirmed_structure, quote_share_token, paid_at, released_at',
    )
    .eq('public_token', token)
    .maybeSingle()

  if (error) return Response.json({ ok: false, error: 'Quote temporarily unavailable' }, { status: 503 })
  if (!row) {
    return Response.json({ ok: false, error: 'Invalid or expired link' }, { status: 404 })
  }
  try {
    const promoted = await approvedRoofPromotion(supabase,row,new URL(req.url).searchParams.get('full') === '1')
    if (promoted) return Response.redirect(new URL(`/api/q/${promoted}/pdf`,req.url),302)
  } catch { return Response.json({ok:false,error:'Promoted quote temporarily unavailable'},{status:503}) }
  if (!row.released_at) return Response.json({ok:false,error:'Awaiting roofer approval'},{status:409})
  if (row.routing === 'inspection_required') {
    return Response.json(
      { ok: false, error: 'This roof needs a site visit first — no PDF until the price is confirmed' },
      { status: 404 },
    )
  }

  // ALWAYS delegate to ensureRoofQuotePdf — it owns the cached-vs-regenerate
  // decision via the path rev marker, so a PDF cached by an older template/
  // figure era self-heals on the next download (serving row.pdf_path directly
  // here bypassed that check and pinned stale PDFs forever).
  //
  // The PDF renders from the tradie's persisted structure selection
  // (included_indices), not the full quote: the headline total covers the
  // INCLUDED quotable structures only. Since the document became the CUSTOMER
  // view (five sections, no structures table) the excluded/inspection-routed
  // rows are no longer listed — displayRows is passed for the narrowing it
  // drives, not for display. The selection-update route nulls pdf_path on
  // change, so a cached PDF always reflects the current selection.
  const fullQuote = (row.quote ?? null) as MultiRoofQuote | null
  const effective = resolveEffectiveIndices(
    {
      included: row.included_indices as number[] | null,
      confirmedStructure: row.confirmed_structure as number | null,
    },
    fullQuote,
  )
  const partition = fullQuote ? partitionRoofQuote(fullQuote, effective) : null
  const path = await ensureRoofQuotePdf(
    token,
    partition ? { quote: partition.narrowed, displayRows: partition.rows } : {},
  )
  if (!path) {
    return Response.json({ ok: false, error: 'PDF unavailable right now — try again shortly' }, { status: 503 })
  }

  let pdf: Buffer
  try {
    pdf = await downloadQuotePdf(path)
  } catch (e) {
    console.error('[q/roof/pdf] storage download failed', e instanceof Error ? e.message : e)
    return Response.json({ ok: false, error: 'PDF unavailable' }, { status: 500 })
  }

  // Land this document in the tradie's Files tab (best-effort, post-response).
  after(() => archiveQuoteOnDownload({ sourceKind: 'quote', sourceId: token, trade: 'roofing' }))

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="roof-quote-${token.slice(0, 8)}.pdf"`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}

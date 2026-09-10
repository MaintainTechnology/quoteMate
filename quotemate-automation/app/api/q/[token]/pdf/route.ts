import { genericQuoteReleased } from '@/lib/quote/customer-release'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { isQuotePageOwner } from '@/lib/quote/page-owner'
// GET /api/q/[token]/pdf — download the customer quote PDF (electrical +
// plumbing G/B/B quotes). Token = quotes.share_token, same trust model as
// the /q/[token] page. Lazy-generates via Gotenberg on first hit (covers
// quotes sent before the PDF feature, or a Gotenberg blip at send time)
// and streams from the private quote-pdfs bucket so the link is stable.

import { after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { ensureQuotePdf, downloadQuotePdf } from '@/lib/quote/pdf'
import { QuotePricingVersionError } from '@/lib/quote/pricing-version'
import { archiveQuoteOnDownload } from '@/lib/filestore/archive-on-download'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60 // lazy Gotenberg render on a cold link

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  // The dashboard viewer embeds the PDF with ?disposition=inline so it renders
  // in an <iframe> instead of forcing a download. Default stays `attachment`
  // (the Download button + every existing link/SMS keep their behaviour).
  const inline = new URL(req.url).searchParams.get('disposition') === 'inline'

  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select('id, intake_id, tenant_id, status, sent_at, paid_at, customer_released_at, pdf_path, needs_inspection')
    .eq('share_token', token)
    .maybeSingle()

  if (quoteError) return Response.json({ok:false,error:'Quote temporarily unavailable'},{status:503})
  if (!quote) {
    return Response.json({ ok: false, error: 'Invalid or expired link' }, { status: 404 })
  }
  if (!genericQuoteReleased(quote)) {
    const owner = await resolveTenantRequest(supabase,req,'id')
    if (owner?.tenant?.id !== quote.tenant_id && !await isQuotePageOwner(supabase,quote.tenant_id)) return Response.json({ok:false,error:'Quote awaiting tradie review'},{status:403})
  }
  if (quote.needs_inspection) {
    return Response.json(
      { ok: false, error: 'This quote needs a site visit first — no PDF until the price is real' },
      { status: 404 },
    )
  }

  // Only the generator can approve a cache signature against the saved price
  // basis. A stale/unverified PDF must not bypass review when rendering fails.
  let path: string | null
  try {
    path = await ensureQuotePdf(quote.id as string, { strictPricing: true })
  } catch (error) {
    if (error instanceof QuotePricingVersionError) {
      return Response.json({ ok: false, error: error.code }, { status: error.status })
    }
    return Response.json({ ok: false, error: 'PDF unavailable' }, { status: 503 })
  }
  if (!path) {
    return Response.json({ ok: false, error: 'PDF unavailable right now — try again shortly' }, { status: 503 })
  }

  let pdf: Buffer
  try {
    pdf = await downloadQuotePdf(path)
  } catch (e) {
    console.error('[q/pdf] storage download failed', e instanceof Error ? e.message : e)
    return Response.json({ ok: false, error: 'PDF unavailable' }, { status: 500 })
  }

  // Land this document in the tradie's Files tab (best-effort, post-response).
  // The quote's trade lives on its intake (electrical | plumbing); default to
  // electrical when unavailable. archiveQuoteOnDownload no-ops when the flag is
  // off or the quote is orphaned, so this never affects the download.
  after(async () => {
    if (process.env.TENANT_FILESTORE_ENABLED !== 'true') return
    let trade = 'electrical'
    try {
      if (quote.intake_id) {
        const { data: intake } = await supabase
          .from('intakes')
          .select('trade')
          .eq('id', quote.intake_id as string)
          .maybeSingle()
        if (intake?.trade) trade = String(intake.trade)
      }
    } catch {
      /* fall back to electrical */
    }
    await archiveQuoteOnDownload({ sourceKind: 'quote', sourceId: quote.id as string, trade })
  })

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="quote-${token.slice(0, 8)}.pdf"`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}

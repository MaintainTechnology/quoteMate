// GET /api/q/[token]/html — the customer quote report as self-contained HTML.
// Token = quotes.share_token (same trust model as /api/q/[token]/pdf and the
// /q/[token] page). This is the SAME document Gotenberg renders to PDF
// (buildQuoteReportHtml), served as text/html so the dashboard quote viewer can
// embed a live, edit-reactive preview instead of a frozen PDF snapshot.
//
// Held reports require the authenticated owner; released reports follow the
// public PDF contract. Editing still flows exclusively through the structured, grounded
// TradieEditor → POST /api/quote/[id]/edit; because this route reads the live
// quotes row every call, the preview reflects a saved edit on the next reload.

import { createClient } from '@supabase/supabase-js'
import { renderQuoteReportHtml } from '@/lib/quote/pdf'
import { genericQuoteReleased } from '@/lib/quote/customer-release'
import { QuotePricingVersionError } from '@/lib/quote/pricing-version'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { isQuotePageOwner } from '@/lib/quote/page-owner'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 30

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

/** Minimal styled placeholder for the states that have no priced report yet. */
function placeholder(title: string, body: string, status: number): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>
    html,body{margin:0;height:100%}
    body{display:grid;place-items:center;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#f6f5f2;color:#2b2422;padding:32px}
    .card{max-width:32rem;text-align:center}
    h1{font-size:1.05rem;font-weight:800;text-transform:uppercase;letter-spacing:-0.01em;margin:0 0 10px}
    p{font-size:0.9rem;line-height:1.55;color:#5e544e;margin:0}
  </style></head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' },
  })
}

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  const { data: quote, error: quoteError } = await supabase
    .from('quotes')
    .select('id,tenant_id,status,sent_at,paid_at,customer_released_at,needs_inspection')
    .eq('share_token', token)
    .maybeSingle()

  if (quoteError) return placeholder('Quote temporarily unavailable','Try again shortly.',503)
  if (!quote) {
    return placeholder('Quote not found', 'This quote link is invalid or has expired.', 404)
  }
  if (!genericQuoteReleased(quote)) {
    const owner = await resolveTenantRequest(supabase,req,'id')
    if (owner?.tenant?.id !== quote.tenant_id && !await isQuotePageOwner(supabase,quote.tenant_id)) {
      return placeholder('Quote awaiting approval','The owning tradie needs to review this quote before its price can be shared.',403)
    }
  }
  if (quote.needs_inspection) {
    return placeholder(
      'Site visit required',
      'This job needs a quick on-site visit before a price can be locked in — there is no priced report to preview yet.',
      200,
    )
  }

  let html: string | null
  try {
    html = await renderQuoteReportHtml(quote.id as string)
  } catch (error) {
    const review = error instanceof QuotePricingVersionError && error.status === 409
    return placeholder(review ? 'Quote pricing needs review' : 'Preview unavailable',
      review ? 'The saved pricing basis could not be verified. The owning tradie needs to review this quote before a priced report can be shown.'
        : 'The report is temporarily unavailable. Please try again shortly.', review ? 409 : 503)
  }
  if (!html) {
    return placeholder(
      'Preview unavailable',
      'We couldn’t build this quote’s report just now. Try again shortly, or use Download PDF.',
      503,
    )
  }

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Always reflect the live quote — the viewer relies on a fresh read after
      // each structured edit save.
      'Cache-Control': 'private, no-store',
    },
  })
}

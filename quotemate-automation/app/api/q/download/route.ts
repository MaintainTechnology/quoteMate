// Download-as-PDF for the redesigned customer quote pages (all trades).
//
// GET /api/q/download?path=/q/<token>[&theme=light|dark]
//
// Renders the ACTUAL live quote page (app/q/*) to PDF via Gotenberg's URL
// route, so the download matches the on-screen redesign 1:1 — no parallel
// HTML template to keep in sync. The `path` is validated against a strict
// allow-list (quote surfaces only) so this can never be turned into an
// open proxy / SSRF. `theme` is passed through so the PDF honours the
// viewer's current dark/light choice.
//
// Separate from /api/q/[token]/pdf (which serves the cached SMS/MMS-attach
// PDF built by the per-trade report-html templates) — this one is the
// "Download PDF" button on the page and otherwise reflects the live design.
//
// ONE EXCEPTION — the EV charger estimate. Its document is a designed template
// (lib/quote/report-html-ev-charger.ts, direction 1B), not a print of the
// customer page, and it is the artefact the customer already received by SMS.
// Screenshotting /q/<token> instead would hand the same customer a second,
// different-looking "estimate" from the same button, so a bare-token EV quote
// is redirected to the cached template PDF. fetch() follows the 302, so the
// page's download button needs no change.

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { renderPdfFromUrl, gotenbergConfigured } from '@/lib/pdf/gotenberg'
import { isEvChargerJob } from '@/lib/quote/report-html-ev-charger'

export const dynamic = 'force-dynamic'
// Gotenberg render can take a few seconds; Vercel Hobby's 10s will time out —
// needs Pro or the Railway/Docker deploy (same constraint as the Opus routes).
export const maxDuration = 60

const APP_URL = (process.env.APP_URL ?? 'https://www.quotemax.com.au').replace(/\/$/, '')

// Allow-list: only the public quote surfaces. Tokens are [A-Za-z0-9_-]; the
// dedicated trades add one path segment (solar/roof/paint/plan/commercial-paint).
const SAFE_PATH = /^\/q\/(?:aircon\/|solar\/|roof\/|paint\/|plan\/|commercial-paint\/)?[A-Za-z0-9_-]{6,}$/

/** A bare `/q/<token>` — the generic funnel, the only shape EV quotes take. */
const BARE_TOKEN_PATH = /^\/q\/([A-Za-z0-9_-]{6,})$/

/**
 * Is this token an EV charger estimate with a real price? Best-effort: any
 * lookup failure returns false and the caller renders the page as before —
 * a download must never 500 because of this check.
 *
 * `needs_inspection` matters: /api/q/[token]/pdf 404s those (there is no
 * priced document yet), so they keep the live-page render.
 */
async function isEvEstimateToken(token: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return false
  try {
    const supabase = createClient(url, key)
    const { data: quote } = await supabase
      .from('quotes')
      .select('intake_id, needs_inspection')
      .eq('share_token', token)
      .maybeSingle()
    if (!quote || quote.needs_inspection || !quote.intake_id) return false

    const { data: intake } = await supabase
      .from('intakes')
      .select('job_type, trade')
      .eq('id', quote.intake_id as string)
      .maybeSingle()
    return isEvChargerJob(
      intake?.job_type as string | null,
      intake?.trade as string | null,
    )
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get('path') ?? ''
  if (!SAFE_PATH.test(path)) {
    return NextResponse.json({ error: 'Invalid quote path' }, { status: 400 })
  }

  // Checked before the Gotenberg gate: the EV template PDF is served from
  // storage and only re-renders when its signature is stale, so that download
  // must keep working on a deploy where Gotenberg is unconfigured.
  const bare = BARE_TOKEN_PATH.exec(path)
  if (bare && (await isEvEstimateToken(bare[1]))) {
    return NextResponse.redirect(new URL(`/api/q/${bare[1]}/pdf`, req.nextUrl.origin), 302)
  }

  if (!gotenbergConfigured()) {
    return NextResponse.json({ error: 'PDF service is not configured' }, { status: 503 })
  }

  const themeParam = req.nextUrl.searchParams.get('theme')
  const theme = themeParam === 'light' || themeParam === 'dark' ? themeParam : null

  // Build the target URL from the trusted APP_URL + the validated path only.
  const target = `${APP_URL}${path}?pdf=1${theme ? `&theme=${theme}` : ''}`
  const token = path.split('/').filter(Boolean).pop() ?? 'quote'
  const filename = `quotemax-quote-${token.slice(0, 12)}.pdf`

  try {
    const pdf = await renderPdfFromUrl(target)
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, no-store, max-age=0',
      },
    })
  } catch (err) {
    console.error('[q/download] PDF render failed', {
      path,
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 502 })
  }
}

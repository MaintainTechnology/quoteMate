// GET /api/q/plan/[token]/pdf — download the Gotenberg-rendered take-off
// report for a shared plan extraction. Token = plan_extractions.share_token
// (unguessable, same trust model as /q/[token]). Streams the stored PDF from
// the private plan-pdfs bucket so the download URL is stable — no signed-URL
// expiry in customer hands.

import { createClient } from '@supabase/supabase-js'
import { quoteReadFailure } from '@/lib/quote/read-failure'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  const { data: extraction, error: readError } = await supabase
    .from('plan_extractions')
    .select('id, report_pdf_path, released_at, plan_uploads(filename)')
    .eq('share_token', token)
    .maybeSingle()

  if (readError) return Response.json({ ok: false, error: 'Report temporarily unavailable',
    correlationId: quoteReadFailure('plan-pdf', readError) }, { status: 503 })
  if (!extraction) {
    return Response.json({ ok: false, error: 'Invalid or expired link' }, { status: 404 })
  }
  if (!extraction.released_at) {
    return Response.json({ ok: false, status: 'awaiting_review', error: 'Your tradie needs to approve this quote before the report can be shared.' }, { status: 409 })
  }
  if (!extraction.report_pdf_path) {
    return Response.json({ ok: false, error: 'No PDF report for this run yet' }, { status: 404 })
  }

  const { data: blob, error } = await supabase.storage
    .from('plan-pdfs')
    .download(extraction.report_pdf_path as string)
  if (error || !blob) {
    console.error('[q/plan/pdf] storage download failed', error?.message)
    return Response.json({ ok: false, error: 'Report unavailable' }, { status: 500 })
  }

  const sourceName = (extraction.plan_uploads as { filename?: string } | null)?.filename ?? 'plan'
  const downloadName = `take-off-${sourceName.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'report'}.pdf`

  return new Response(blob.stream(), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}

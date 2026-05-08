// ════════════════════════════════════════════════════════════════════
// Preview-status endpoint — polled by the quote page's <PreviewSection/>
// client component while preview is generating. Returns:
//   { status, image_url? }
// where status ∈ idle | no_photos | generating | ready | failed and
// image_url is a freshly-signed URL when status='ready'.
//
// Auth: anyone with the quote share_token can read. Same trust model
// as the quote page itself — the token is unguessable.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { refreshSignedUrl } from '@/lib/storage/upload'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export const dynamic = 'force-dynamic'
export const maxDuration = 15

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  const { data: quote, error } = await supabase
    .from('quotes')
    .select('id, preview_status, preview_image_path, preview_generated_at')
    .eq('share_token', token)
    .maybeSingle()

  if (error) {
    return Response.json({ status: 'failed', error: 'lookup failed' }, { status: 500 })
  }
  if (!quote) {
    return Response.json({ status: 'failed', error: 'not found' }, { status: 404 })
  }

  const status = (quote.preview_status as string) ?? 'idle'

  let imageUrl: string | null = null
  if (status === 'ready' && quote.preview_image_path) {
    try {
      imageUrl = await refreshSignedUrl(quote.preview_image_path as string)
    } catch (e: any) {
      console.error('[preview-status] sign failed', { quoteId: quote.id, error: e?.message ?? e })
      // Keep status='ready' but return no URL — client will retry next poll.
    }
  }

  return Response.json({
    status,
    image_url: imageUrl,
    generated_at: quote.preview_generated_at ?? null,
  })
}

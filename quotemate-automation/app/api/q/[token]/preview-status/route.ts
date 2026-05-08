// ════════════════════════════════════════════════════════════════════
// Preview + sample-gallery status endpoint — polled by the quote page's
// <PreviewSection/> client component while either is generating.
//
// Returns:
//   {
//     preview: { status, image_url? },
//     samples: { status, image_urls: [] }
//   }
// where status ∈ idle | no_photos | generating | ready | partial | failed
// and URLs are freshly-signed (24h TTL — re-signed on each poll).
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
    .select('id, preview_status, preview_image_path, preview_generated_at, samples_status, sample_image_paths, samples_generated_at')
    .eq('share_token', token)
    .maybeSingle()

  if (error) {
    return Response.json({ error: 'lookup failed' }, { status: 500 })
  }
  if (!quote) {
    return Response.json({ error: 'not found' }, { status: 404 })
  }

  // ─── Preview (single image) ───
  const previewStatus = (quote.preview_status as string) ?? 'idle'
  let previewImageUrl: string | null = null
  if (previewStatus === 'ready' && quote.preview_image_path) {
    try {
      previewImageUrl = await refreshSignedUrl(quote.preview_image_path as string)
    } catch (e: any) {
      console.error('[preview-status] preview sign failed', { quoteId: quote.id, error: e?.message ?? e })
    }
  }

  // ─── Samples (up to 3 images) ───
  const samplesStatus = (quote.samples_status as string) ?? 'idle'
  const samplePaths = (Array.isArray(quote.sample_image_paths) ? quote.sample_image_paths : []) as string[]
  const sampleImageUrls: string[] =
    (samplesStatus === 'ready' || samplesStatus === 'partial') && samplePaths.length > 0
      ? (await Promise.all(samplePaths.map(p => refreshSignedUrl(p).catch(() => null))))
          .filter((u): u is string => !!u)
      : []

  return Response.json({
    preview: {
      status: previewStatus,
      image_url: previewImageUrl,
      generated_at: quote.preview_generated_at ?? null,
    },
    samples: {
      status: samplesStatus,
      image_urls: sampleImageUrls,
      generated_at: quote.samples_generated_at ?? null,
    },
  })
}

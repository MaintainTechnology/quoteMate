// ════════════════════════════════════════════════════════════════════
// Preview + sample-gallery status endpoint — polled by the quote page's
// <PreviewSection/> while either is generating.
//
// Returns:
//   {
//     preview: { status, image_urls: string[] },   // multi-photo
//     samples: { status, image_urls: string[] }
//   }
// where status ∈ idle | no_photos | generating | ready | partial | failed
// and URLs are freshly-signed (24h TTL — re-signed on each poll).
//
// Auth: anyone with the quote share_token can read.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import { refreshSignedUrl } from '@/lib/storage/upload'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  const { data: quote, error } = await supabase
    .from('quotes')
    .select('id, preview_status, preview_image_paths, preview_image_path, preview_generated_at, samples_status, sample_image_paths, samples_generated_at')
    .eq('share_token', token)
    .maybeSingle()

  if (error) {
    return Response.json({ error: 'lookup failed' }, { status: 500 })
  }
  if (!quote) {
    return Response.json({ error: 'not found' }, { status: 404 })
  }

  // ─── Preview (multi-photo) ───
  // Prefer the new plural column; fall back to the legacy singular path
  // for quotes generated before migration 011 landed.
  const previewStatus = (quote.preview_status as string) ?? 'idle'
  const previewPaths = Array.isArray(quote.preview_image_paths) && quote.preview_image_paths.length > 0
    ? (quote.preview_image_paths as string[])
    : (quote.preview_image_path ? [quote.preview_image_path as string] : [])
  const previewImageUrls: string[] = previewPaths.length === 0
    ? []
    : (await Promise.all(previewPaths.map(p => refreshSignedUrl(p).catch(() => null))))
        .filter((u): u is string => !!u)

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
      image_urls: previewImageUrls,
      generated_at: quote.preview_generated_at ?? null,
    },
    samples: {
      status: samplesStatus,
      image_urls: sampleImageUrls,
      generated_at: quote.samples_generated_at ?? null,
    },
  })
}

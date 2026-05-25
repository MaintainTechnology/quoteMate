// ════════════════════════════════════════════════════════════════════
// WP4 — resolve an operator catalogue product photo into Gemini-ready
// bytes.
//
// tenant_material_catalogue.image_path may be either:
//   • an absolute http(s) URL (the operator pasted a product link), or
//   • a Supabase Storage path in the intake-photos bucket.
// Both resolve to { base64, mime } so generate.ts / samples.ts can
// attach the EXACT product photo as a second image to Gemini.
//
// Best-effort by design: any problem (missing, non-image, too big,
// network/storage error) returns null and the render simply falls back
// to today's text-only behaviour. It NEVER throws into the preview
// pipeline, so WP4 can never regress a quote.
// ════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const BUCKET = 'intake-photos'
// Keep the Gemini payload sane — a product photo over this is almost
// certainly wrong (or a hostile link); skip rather than send it.
const MAX_BYTES = 8 * 1024 * 1024

export type ProductImage = { base64: string; mime: string }

export async function resolveProductImage(
  pathOrUrl: string | null | undefined,
): Promise<ProductImage | null> {
  const p = (pathOrUrl ?? '').trim()
  if (!p) return null
  try {
    if (/^https?:\/\//i.test(p)) {
      const res = await fetch(p)
      if (!res.ok) return null
      const ct = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
      if (!/^image\//i.test(ct)) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0 || buf.length > MAX_BYTES) return null
      return { base64: buf.toString('base64'), mime: ct }
    }
    // Otherwise treat it as a storage path in the intake-photos bucket.
    const { data: blob, error } = await supabase.storage.from(BUCKET).download(p)
    if (error || !blob) return null
    const buf = Buffer.from(await blob.arrayBuffer())
    if (buf.length === 0 || buf.length > MAX_BYTES) return null
    return { base64: buf.toString('base64'), mime: blob.type || 'image/jpeg' }
  } catch {
    return null
  }
}

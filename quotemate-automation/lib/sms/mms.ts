// ════════════════════════════════════════════════════════════════════
// Phase 4 / photos — extract MMS attachments from a Twilio inbound webhook
// and ferry them into our existing intake-photos Supabase Storage bucket.
//
// Twilio sends MMS metadata on the same form body as the SMS itself:
//   NumMedia          — string count (e.g. "0", "1", "2", ...)
//   MediaUrl0..N      — fetch URLs (require Basic auth: SID:AUTH_TOKEN)
//   MediaContentType0..N — e.g. "image/jpeg", "image/png", "image/webp"
//
// Process:
//   1. parse NumMedia
//   2. for each index i: GET MediaUrlI with Basic auth, upload via the
//      existing uploadIntakePhoto helper (keyed off conversationId so
//      paths read as <conversationId>/<stamp>-<i>-<rand>.<ext>)
//   3. return signed URLs ready to store on sms_messages.photo_urls
//
// The signed URLs are valid for 24h (per uploadIntakePhoto), long enough
// for the structureIntake call to consume them via Sonnet/Opus vision.
// ════════════════════════════════════════════════════════════════════

import { uploadIntakePhoto } from '@/lib/storage/upload'

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])

export type MmsExtractResult = {
  /** Signed URLs ready for storage on sms_messages.photo_urls */
  signedUrls: string[]
  /** Permanent storage paths, parallel-indexed with signedUrls.
   *  Persisted on sms_messages.photo_paths so the public quote page
   *  can re-sign on demand (signed URLs expire after 24h). */
  paths: string[]
  /** Per-attachment outcome for diagnostic logging */
  attempts: Array<
    | { index: number; ok: true; signedUrl: string; path: string; contentType: string }
    | { index: number; ok: false; reason: string; contentType?: string }
  >
}

export async function extractAndStoreMmsPhotos(opts: {
  conversationId: string
  /** The full Twilio inbound form params (Body, From, To, NumMedia, MediaUrl0, etc.) */
  params: Record<string, string>
}): Promise<MmsExtractResult> {
  const numMedia = parseInt(opts.params['NumMedia'] ?? '0', 10)
  if (!Number.isFinite(numMedia) || numMedia <= 0) {
    return { signedUrls: [], paths: [], attempts: [] }
  }

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) {
    return {
      signedUrls: [],
      paths: [],
      attempts: Array.from({ length: numMedia }, (_, i) => ({
        index: i,
        ok: false as const,
        reason: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing',
      })),
    }
  }

  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')

  const signedUrls: string[] = []
  const paths: string[] = []
  const attempts: MmsExtractResult['attempts'] = []

  for (let i = 0; i < numMedia; i++) {
    const url = opts.params[`MediaUrl${i}`]
    const contentType = opts.params[`MediaContentType${i}`] ?? 'application/octet-stream'

    if (!url) {
      attempts.push({ index: i, ok: false, reason: 'MediaUrl missing' })
      continue
    }

    if (!ALLOWED_MIME.has(contentType)) {
      attempts.push({ index: i, ok: false, reason: `unsupported content-type ${contentType}`, contentType })
      continue
    }

    try {
      // 1. Fetch the media binary from Twilio.
      const res = await fetch(url, { headers: { Authorization: auth } })
      if (!res.ok) {
        attempts.push({ index: i, ok: false, reason: `Twilio media GET ${res.status}`, contentType })
        continue
      }
      const buf = await res.arrayBuffer()

      // 2. Upload via our existing storage helper (re-using callId param for the
      //    path key — works fine for conversationIds, paths read as
      //    <conversationId>/<stamp>-<i>-<rand>.<ext>).
      const { signedUrl, path } = await uploadIntakePhoto({
        callId: opts.conversationId,
        data: buf,
        contentType,
        index: i,
      })

      signedUrls.push(signedUrl)
      paths.push(path)
      attempts.push({ index: i, ok: true, signedUrl, path, contentType })
    } catch (e: any) {
      attempts.push({ index: i, ok: false, reason: e?.message ?? String(e), contentType })
    }
  }

  return { signedUrls, paths, attempts }
}

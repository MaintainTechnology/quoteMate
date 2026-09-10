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
import sharp from 'sharp'

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_MEDIA_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENTS = 10

export function detectedImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' &&
      Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP') return 'image/webp'
  return null
}

/** Provider credentials are sent only to this account's canonical media resource. */
export function authorisedTwilioMediaUrl(raw: string, accountSid: string): URL {
  const url = new URL(raw)
  const expected = `/2010-04-01/Accounts/${accountSid}/Messages/`
  if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com' || url.port ||
      url.username || url.password || url.search || url.hash || !url.pathname.startsWith(expected) ||
      !/^SM[0-9a-f]{32}\/Media\/ME[0-9a-f]{32}$/.test(url.pathname.slice(expected.length))) {
    throw new Error('Untrusted Twilio media resource')
  }
  return url
}

async function fetchMediaBytes(raw: string, accountSid: string, auth: string): Promise<Uint8Array> {
  let url = authorisedTwilioMediaUrl(raw, accountSid)
  const signal = AbortSignal.timeout(15_000)
  let authenticated = true
  for (let redirects = 0; redirects <= 3; redirects++) {
    const res = await fetch(url.href, { redirect: 'manual', signal,
      headers: authenticated ? { Authorization: auth } : {} })
    if ([301,302,303,307,308].includes(res.status)) {
      const location = res.headers.get('location')
      await res.body?.cancel()
      if (!location) throw new Error('Media redirect has no location')
      const target = new URL(location, url)
      // Twilio's secured media redirect host. Never send Basic credentials to its CDN.
      if (target.protocol !== 'https:' || target.hostname !== 'mms.twiliocdn.com' || target.port || target.username || target.password) {
        throw new Error('Untrusted media redirect')
      }
      url = target
      authenticated = false
      continue
    }
    if (!res.ok) throw new Error(`Twilio media GET ${res.status}`)
    if (Number(res.headers.get('content-length') ?? 0) > MAX_MEDIA_BYTES) {
      await res.body?.cancel(); throw new Error('Media exceeds 5 MB')
    }
    if (!res.body) throw new Error('Empty media response')
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.length
        if (length > MAX_MEDIA_BYTES) throw new Error('Media exceeds 5 MB')
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return Buffer.concat(chunks, length)
  }
  throw new Error('Too many media redirects')
}

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
  if (numMedia > MAX_ATTACHMENTS) return { signedUrls: [], paths: [], attempts: [{ index: 0, ok: false, reason: 'Too many attachments' }] }

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
      const bytes = await fetchMediaBytes(url, sid, auth)
      const actualType = detectedImageType(bytes)
      if (actualType !== contentType) throw new Error('Media bytes do not match declared image type')
      // Decode under a pixel ceiling as well as a compressed-byte ceiling.
      // Magic bytes alone would accept truncated images or decompression bombs.
      const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: 25_000_000 })
      const metadata = await decoder.metadata()
      if (!metadata.width || !metadata.height) throw new Error('Image dimensions missing')
      await decoder.stats()
      const buf = new Uint8Array(bytes).buffer

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
    } catch (e) {
      attempts.push({ index: i, ok: false, reason: e instanceof Error ? e.message : String(e), contentType })
    }
  }

  return { signedUrls, paths, attempts }
}

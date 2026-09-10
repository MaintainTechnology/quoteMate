// Shared "send a quote SMS, attach its PDF as a best-effort MMS" glue.
//
// Every trade's customer-quote send repeats the same tail:
//   1. a PDF was (maybe) rendered → a storage path, or null
//   2. the SMS body already carries the durable PDF download link
//   3. sign a SHORT-LIVED public URL for the Twilio MMS media fetch —
//      best-effort: a signing failure must NOT block the SMS
//   4. dispatch, letting dispatchQuoteMessage drop the media to a plain
//      SMS if the carrier rejects the MMS (AU long codes routinely do)
//
// Copy-pasting that tail across estimate/draft, approve, edit, roofing and
// the plan estimator is how solar silently shipped with NO MMS at all. This
// helper is the single chokepoint so a new trade inherits the behaviour by
// construction. The body link itself stays caller-built (it's woven into
// trade-specific copy) via the pure *PdfUrl() helpers.
//
// Bucket-agnostic: the caller injects the signer (signQuotePdfUrl for the
// quote-pdfs bucket, signPlanPdfUrl for plan-pdfs).

import { dispatchQuoteMessage, type DispatchResult } from './dispatch'
import type { OutboundOptions } from './durable-outbox'

// RC-7 — Twilio's hard MMS media limit. The canonical stored quote PDF is now
// the FULL-image document (so dashboard-download + the /api/q/[token]/pdf link
// show every logo/aerial, matching the live preview). An oversized PDF must
// NOT be attached as MMS media: Twilio ACCEPTS the send synchronously and only
// fails delivery asynchronously, so dispatch's synchronous MMS→SMS fallback
// never fires and the customer gets a broken/empty MMS. Instead the MMS signer
// throws for an over-cap PDF, dispatchQuoteWithPdf degrades to a plain SMS, and
// the body's durable link still serves the SAME full PDF.
export const MMS_MEDIA_CAP_BYTES = 5 * 1024 * 1024

/** True when a stored PDF is too large to attach as MMS media. Unknown size →
 *  false (best-effort: never block a send on a missing size lookup). */
export function exceedsMmsMediaCap(bytes: number | null | undefined): boolean {
  return typeof bytes === 'number' && bytes > MMS_MEDIA_CAP_BYTES
}

// The size cap above only catches ONE way an MMS dies asynchronously. The
// other, observed in production 2026-07-22: an AU long code that does not
// support MMS at all. Twilio accepts the send, the status sticks at 'sent'
// and never reaches 'delivered' — so the customer loses the ENTIRE message,
// body and all, not just the attachment. Two roofing quotes were lost this
// way while every media-free SMS on the same thread delivered fine.
//
// The body always carries a durable "PDF copy: …" link, so the attachment
// buys us nothing the customer can't already reach. Default OFF; a
// deployment that knows its numbers do MMS can opt back in.
export function quotePdfMmsEnabled(): boolean {
  return process.env.SMS_QUOTE_PDF_MMS === '1'
}

export async function dispatchQuoteWithPdf(opts: Omit<OutboundOptions, 'mediaUrl' | 'mediaKey'> & {
  /** Storage path of the rendered PDF, or null when none was produced
   *  (Gotenberg unconfigured, inspection-routed, render failed). */
  pdfPath: string | null
  /** Best-effort signer → short-lived public URL for the Twilio MMS fetch.
   *  Only called when pdfPath is non-null; a throw degrades to plain SMS. */
  signMediaUrl: (path: string) => Promise<string>
}): Promise<DispatchResult> {
  const { pdfPath, signMediaUrl, ...delivery } = opts
  let mediaUrl: string | undefined
  if (pdfPath && quotePdfMmsEnabled()) {
    try {
      mediaUrl = await signMediaUrl(pdfPath)
    } catch (e) {
      console.warn(
        '[send-quote-pdf] MMS media sign failed — sending plain SMS (body link still carries the PDF)',
        e instanceof Error ? e.message : e,
      )
      mediaUrl = undefined
    }
  }

  return dispatchQuoteMessage({
    ...delivery,
    // Remains stable when the signed URL is renewed or signing degrades to SMS.
    ...(pdfPath ? { mediaKey: pdfPath } : {}),
    ...(mediaUrl ? { mediaUrl } : {}),
  })
}

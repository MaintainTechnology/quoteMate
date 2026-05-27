// Invoice extraction — Gemini-vision-backed parser for past invoice
// images/PDFs. Returns the structured form fed into the calibration
// pipeline (lib/dashboard/invoice-calibration.ts).
//
// Design choice: ONE Gemini call returns structured JSON directly.
// (We could split into vision-OCR → Opus-structuring, but for v1
// the single call is cheaper, faster, and easier to test.) Gemini
// natively understands invoice imagery so we lean on its native
// vision rather than re-OCRing.
//
// Injectable fetch + apiKey so the route can wire the real Gemini
// endpoint while tests inject canned responses.

import { z } from 'zod'

// The structured invoice shape — mirrors InvoiceExtraction from
// lib/dashboard/invoice-calibration.ts (same field names so the
// API route can hand the output straight to calibration).
export const ExtractedInvoiceSchema = z.object({
  scope_description: z.string().min(1),
  total_inc_gst: z.number().positive(),
  job_type_guess: z
    .enum([
      'downlights',
      'power_points',
      'ceiling_fans',
      'smoke_alarms',
      'outdoor_lighting',
      'blocked_drain',
      'hot_water',
      'tap_repair',
      'tap_replace',
      'toilet_repair',
      'toilet_replace',
    ])
    .nullable()
    .optional(),
  quantity: z.number().nullable().optional(),
  customer_name: z.string().nullable().optional(),
  customer_suburb: z.string().nullable().optional(),
  invoice_date: z.string().nullable().optional(),
})
export type ExtractedInvoice = z.infer<typeof ExtractedInvoiceSchema>

// ─────────────────────────────────────────────────────────────────────
// Extraction prompt — concise and grounded.
// ─────────────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are extracting structured fields from a tradie's past invoice for an AU electrical or plumbing business. Return ONLY valid JSON matching this schema:

{
  "scope_description": string (1+ chars — free-text summary of work done, e.g. "Replaced 6 LED downlights"),
  "total_inc_gst": number (the inc-GST customer total — the single most reliable figure on the invoice),
  "job_type_guess": one of: "downlights" | "power_points" | "ceiling_fans" | "smoke_alarms" | "outdoor_lighting" | "blocked_drain" | "hot_water" | "tap_repair" | "tap_replace" | "toilet_repair" | "toilet_replace" — or null if unclear,
  "quantity": integer count of the primary item (e.g. 6 if "6 downlights") — or null,
  "customer_name": string or null,
  "customer_suburb": string or null,
  "invoice_date": ISO date string (YYYY-MM-DD) or null
}

Rules:
- Do NOT invent numbers. If you can't read the total clearly, return null.
- total_inc_gst is the GRAND TOTAL the customer paid, inc GST. Not a sub-line.
- scope_description should be one short sentence summarising what was done.
- Output VALID JSON only — no markdown fences, no commentary.`

// ─────────────────────────────────────────────────────────────────────
// Pluggable fetch + key for testing
// ─────────────────────────────────────────────────────────────────────

export type ExtractOptions = {
  /** Override the Gemini text model (defaults to gemini-2.5-flash). */
  model?: string
  /** Injected fetch — defaults to globalThis.fetch. */
  fetchFn?: typeof fetch
  /** Injected API key — defaults to process.env.GEMINI_API_KEY. */
  apiKey?: string
}

export type ExtractRequest = {
  /** Base64-encoded image bytes (no data: prefix). */
  imageBase64: string
  /** MIME type, e.g. "image/jpeg", "image/png", "application/pdf". */
  mimeType: string
}

export type ExtractResult =
  | { ok: true; extraction: ExtractedInvoice; raw: unknown }
  | { ok: false; reason: 'no_api_key' | 'http_error' | 'no_text' | 'bad_json' | 'schema_invalid'; message: string; raw?: unknown }

const DEFAULT_MODEL = 'gemini-2.5-flash'

/**
 * Extract structured invoice data from an image via Gemini vision.
 *
 * Failure modes are returned as { ok: false } with a typed reason, NOT
 * thrown. The API route translates these to user-facing statuses on the
 * invoice_uploads row.
 */
export async function extractInvoice(
  request: ExtractRequest,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY
  if (!apiKey) {
    return {
      ok: false,
      reason: 'no_api_key',
      message: 'GEMINI_API_KEY is not set. Invoice extraction is disabled.',
    }
  }
  const fetchImpl = options.fetchFn ?? fetch
  const model = options.model ?? DEFAULT_MODEL
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`

  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: EXTRACTION_PROMPT },
          {
            inline_data: {
              mime_type: request.mimeType,
              data: request.imageBase64,
            },
          },
        ],
      },
    ],
    generation_config: {
      temperature: 0.1,
      response_mime_type: 'application/json',
    },
  }

  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return {
      ok: false,
      reason: 'http_error',
      message: `Network error calling Gemini: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return {
      ok: false,
      reason: 'http_error',
      message: `Gemini returned HTTP ${res.status}: ${body.slice(0, 500)}`,
    }
  }
  const json: any = await res.json().catch(() => null)
  if (!json) {
    return {
      ok: false,
      reason: 'http_error',
      message: 'Gemini response was not JSON',
    }
  }

  // Find the text part on the first candidate.
  const text = json?.candidates?.[0]?.content?.parts
    ?.map((p: any) => p?.text)
    ?.filter(Boolean)
    ?.join('') ?? ''
  if (!text || typeof text !== 'string') {
    return {
      ok: false,
      reason: 'no_text',
      message: 'Gemini returned no text part',
      raw: json,
    }
  }

  // The model is asked for JSON. Try to parse — if it wrapped in fences
  // strip them defensively.
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFences(text))
  } catch (e) {
    return {
      ok: false,
      reason: 'bad_json',
      message: `Could not parse Gemini output as JSON: ${e instanceof Error ? e.message : String(e)}`,
      raw: text,
    }
  }

  const validated = ExtractedInvoiceSchema.safeParse(parsed)
  if (!validated.success) {
    return {
      ok: false,
      reason: 'schema_invalid',
      message: `Gemini output didn't match the invoice schema: ${validated.error.message}`,
      raw: parsed,
    }
  }

  return { ok: true, extraction: validated.data, raw: parsed }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function stripCodeFences(s: string): string {
  // Sometimes the model wraps JSON in ```json ... ``` despite the
  // response_mime_type hint. Strip both opening + closing fences.
  let t = s.trim()
  if (t.startsWith('```')) {
    // Drop first line (which may be ``` or ```json).
    const firstNewline = t.indexOf('\n')
    if (firstNewline >= 0) t = t.slice(firstNewline + 1)
    if (t.endsWith('```')) t = t.slice(0, -3)
  }
  return t.trim()
}

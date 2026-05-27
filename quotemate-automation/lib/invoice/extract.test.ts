// Tests for the invoice-extraction module.
// Mocks the global fetch so no network calls happen.

import { describe, expect, it } from 'vitest'
import { extractInvoice, ExtractedInvoiceSchema } from './extract'

function mkResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text }],
          },
        },
      ],
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

// ──────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────

describe('ExtractedInvoiceSchema', () => {
  it('accepts a full valid extraction', () => {
    const r = ExtractedInvoiceSchema.safeParse({
      scope_description: 'Replaced 6 LED downlights in the kitchen',
      total_inc_gst: 850,
      job_type_guess: 'downlights',
      quantity: 6,
      customer_name: 'Jane Doe',
      customer_suburb: 'Chandler',
      invoice_date: '2026-05-20',
    })
    expect(r.success).toBe(true)
  })

  it('accepts minimal extraction (scope + total only)', () => {
    const r = ExtractedInvoiceSchema.safeParse({
      scope_description: 'replaced 6 LED downlights',
      total_inc_gst: 850,
    })
    expect(r.success).toBe(true)
  })

  it('rejects empty scope', () => {
    const r = ExtractedInvoiceSchema.safeParse({
      scope_description: '',
      total_inc_gst: 850,
    })
    expect(r.success).toBe(false)
  })

  it('rejects zero or negative total', () => {
    expect(
      ExtractedInvoiceSchema.safeParse({ scope_description: 'x', total_inc_gst: 0 }).success,
    ).toBe(false)
    expect(
      ExtractedInvoiceSchema.safeParse({ scope_description: 'x', total_inc_gst: -5 }).success,
    ).toBe(false)
  })

  it('rejects invalid job_type_guess enum value', () => {
    const r = ExtractedInvoiceSchema.safeParse({
      scope_description: 'work',
      total_inc_gst: 100,
      job_type_guess: 'mystery_job',
    })
    expect(r.success).toBe(false)
  })

  it('accepts null for optional fields', () => {
    const r = ExtractedInvoiceSchema.safeParse({
      scope_description: 'work',
      total_inc_gst: 100,
      job_type_guess: null,
      quantity: null,
      customer_name: null,
    })
    expect(r.success).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────
// extractInvoice
// ──────────────────────────────────────────────────────────────────────

describe('extractInvoice', () => {
  it('returns no_api_key when GEMINI_API_KEY is unset', async () => {
    const r = await extractInvoice(
      { imageBase64: 'xxx', mimeType: 'image/jpeg' },
      { apiKey: undefined, fetchFn: undefined as unknown as typeof fetch },
    )
    if (r.ok) throw new Error('unexpected success')
    expect(r.reason).toBe('no_api_key')
  })

  it('parses valid JSON output from Gemini', async () => {
    const fakeJson = JSON.stringify({
      scope_description: 'Replaced 6 LED downlights',
      total_inc_gst: 850,
      job_type_guess: 'downlights',
      quantity: 6,
    })
    const fakeFetch = async () => mkResponse(fakeJson)
    const r = await extractInvoice(
      { imageBase64: 'xxx', mimeType: 'image/jpeg' },
      { apiKey: 'fake', fetchFn: fakeFetch as unknown as typeof fetch },
    )
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason} — ${r.message}`)
    expect(r.extraction.scope_description).toBe('Replaced 6 LED downlights')
    expect(r.extraction.total_inc_gst).toBe(850)
    expect(r.extraction.job_type_guess).toBe('downlights')
    expect(r.extraction.quantity).toBe(6)
  })

  it('strips code fences around JSON output', async () => {
    const fakeJson = '```json\n{"scope_description":"Replaced taps","total_inc_gst":420}\n```'
    const fakeFetch = async () => mkResponse(fakeJson)
    const r = await extractInvoice(
      { imageBase64: 'xxx', mimeType: 'image/jpeg' },
      { apiKey: 'fake', fetchFn: fakeFetch as unknown as typeof fetch },
    )
    if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`)
    expect(r.extraction.total_inc_gst).toBe(420)
  })

  it('returns http_error on non-200', async () => {
    const fakeFetch = async () =>
      new Response('quota exceeded', { status: 429 })
    const r = await extractInvoice(
      { imageBase64: 'xxx', mimeType: 'image/jpeg' },
      { apiKey: 'fake', fetchFn: fakeFetch as unknown as typeof fetch },
    )
    if (r.ok) throw new Error('unexpected success')
    expect(r.reason).toBe('http_error')
    expect(r.message).toContain('429')
  })

  it('returns no_text when candidates have no text part', async () => {
    const emptyResponse = new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const fakeFetch = async () => emptyResponse
    const r = await extractInvoice(
      { imageBase64: 'xxx', mimeType: 'image/jpeg' },
      { apiKey: 'fake', fetchFn: fakeFetch as unknown as typeof fetch },
    )
    if (r.ok) throw new Error('unexpected success')
    expect(r.reason).toBe('no_text')
  })

  it('returns bad_json on unparseable text', async () => {
    const fakeFetch = async () => mkResponse('this is not json at all')
    const r = await extractInvoice(
      { imageBase64: 'xxx', mimeType: 'image/jpeg' },
      { apiKey: 'fake', fetchFn: fakeFetch as unknown as typeof fetch },
    )
    if (r.ok) throw new Error('unexpected success')
    expect(r.reason).toBe('bad_json')
  })

  it('returns schema_invalid on JSON that misses required fields', async () => {
    const fakeFetch = async () => mkResponse('{"customer_name": "Jane"}')
    const r = await extractInvoice(
      { imageBase64: 'xxx', mimeType: 'image/jpeg' },
      { apiKey: 'fake', fetchFn: fakeFetch as unknown as typeof fetch },
    )
    if (r.ok) throw new Error('unexpected success')
    expect(r.reason).toBe('schema_invalid')
  })

  it('returns http_error when fetch throws', async () => {
    const fakeFetch = async () => {
      throw new Error('ECONNREFUSED')
    }
    const r = await extractInvoice(
      { imageBase64: 'xxx', mimeType: 'image/jpeg' },
      { apiKey: 'fake', fetchFn: fakeFetch as unknown as typeof fetch },
    )
    if (r.ok) throw new Error('unexpected success')
    expect(r.reason).toBe('http_error')
    expect(r.message).toContain('ECONNREFUSED')
  })
})

// POST /api/tenant/calibration/upload — A5 invoice upload entry point.
//
// Accepts a base64-encoded invoice image, runs Gemini vision extraction,
// persists the upload + extraction to the DB, and returns the structured
// extraction back to the caller so the dashboard can show it immediately.
//
// V1 scope (image only — PDF support is later):
//   1. POST body: { image_base64, mime_type }  (multipart later)
//   2. Insert invoice_uploads row with status='extracting'
//   3. Call extractInvoice(...)
//   4. On success: insert invoice_extractions row, flip status='extracted'
//      On failure: flip status='failed' + set error
//   5. Return { ok: true|false, upload_id, extraction?, error? }
//
// Synchronous — extraction takes ~3-10s for an image, well within the
// route timeout. If we add PDF support we'll fan extraction out to
// after()/queue. Single-tenant scoped; no cross-tenant access.

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { extractInvoice } from '@/lib/invoice/extract'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const BodySchema = z.object({
  image_base64: z.string().min(1),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
})

async function tenantFromBearer(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, trade, trades')
    .eq('owner_user_id', data.user.id)
    .maybeSingle()
  if (!tenant) return null
  return tenant as { id: string; trade: string | null; trades: string[] | null }
}

export async function POST(req: Request) {
  const tenant = await tenantFromBearer(req)
  if (!tenant) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'validation_failed', fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    )
  }

  // 1. Stub upload row immediately so failures still appear in the audit.
  const { data: upload, error: upErr } = await supabase
    .from('invoice_uploads')
    .insert({
      tenant_id: tenant.id,
      mime_type: parsed.data.mime_type,
      status: 'extracting',
    })
    .select('id')
    .single()
  if (upErr || !upload) {
    return Response.json(
      { ok: false, error: 'upload_insert_failed', message: upErr?.message ?? 'no row returned' },
      { status: 500 },
    )
  }

  // 2. Run extraction.
  const result = await extractInvoice({
    imageBase64: parsed.data.image_base64,
    mimeType: parsed.data.mime_type,
  })

  if (!result.ok) {
    await supabase
      .from('invoice_uploads')
      .update({ status: 'failed', error: `${result.reason}: ${result.message}` })
      .eq('id', upload.id)
      .eq('tenant_id', tenant.id)
    return Response.json(
      {
        ok: false,
        upload_id: upload.id,
        error: result.reason,
        message: result.message,
      },
      { status: 502 },
    )
  }

  // 3. Persist the structured extraction.
  const ext = result.extraction
  const { data: extRow, error: extErr } = await supabase
    .from('invoice_extractions')
    .insert({
      upload_id: upload.id,
      tenant_id: tenant.id,
      raw: result.raw,
      scope_description: ext.scope_description,
      total_inc_gst: ext.total_inc_gst,
      job_type_guess: ext.job_type_guess ?? null,
      quantity: ext.quantity ?? null,
      customer_name: ext.customer_name ?? null,
      customer_suburb: ext.customer_suburb ?? null,
      invoice_date: ext.invoice_date ?? null,
    })
    .select('id')
    .single()
  if (extErr) {
    await supabase
      .from('invoice_uploads')
      .update({ status: 'failed', error: `extraction_insert: ${extErr.message}` })
      .eq('id', upload.id)
      .eq('tenant_id', tenant.id)
    return Response.json(
      { ok: false, upload_id: upload.id, error: 'extraction_insert_failed', message: extErr.message },
      { status: 500 },
    )
  }

  await supabase
    .from('invoice_uploads')
    .update({ status: 'extracted', error: null })
    .eq('id', upload.id)
    .eq('tenant_id', tenant.id)

  return Response.json({
    ok: true,
    upload_id: upload.id,
    extraction_id: extRow?.id,
    extraction: ext,
  })
}

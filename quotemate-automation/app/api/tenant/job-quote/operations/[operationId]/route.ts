import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { loadJobQuoteOperation, readJobQuoteOperation } from '@/lib/quote/job-quote-operation'

export const dynamic = 'force-dynamic'
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

export async function GET(req: Request, context: { params: Promise<{ operationId: string }> }) {
  const resolved = await resolveTenantRequest(supabase, req, 'id')
  const tenantId = resolved?.tenant?.id
  if (typeof tenantId !== 'string') return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  const parsed = z.string().uuid().transform(value => value.toLowerCase()).safeParse((await context.params).operationId)
  if (!parsed.success) return Response.json({ ok: false, error: 'invalid_operation' }, { status: 400 })
  try {
    const operation = await loadJobQuoteOperation(supabase, tenantId, parsed.data)
    if (!operation) return Response.json({ ok: false, error: 'operation_not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    return Response.json(await readJobQuoteOperation(supabase, operation), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return Response.json({ ok: false, error: 'operation_read_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}

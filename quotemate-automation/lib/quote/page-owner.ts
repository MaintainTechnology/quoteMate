import { headers } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveTenantRequest } from '@/lib/tenant/from-request'

/** Server-rendered held previews require a verified owner, including Clerk navigation cookies. */
export async function isQuotePageOwner(db: SupabaseClient, tenantId: unknown): Promise<boolean> {
  if (!tenantId) return false
  const incoming = await headers()
  const authorization = incoming.get('authorization')
  const session = incoming.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('__session='))?.slice(10)
  if (!authorization && !session) return false
  let bearer = authorization
  try { bearer ??= `Bearer ${decodeURIComponent(session!)}` } catch { return false }
  const request = new Request('https://quotemax.invalid/owner-preview', {
    headers: { authorization: bearer },
  })
  const owner = await resolveTenantRequest(db,request,'id')
  return owner?.tenant?.id === tenantId
}

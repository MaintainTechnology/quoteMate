import { createClient } from '@supabase/supabase-js'
import { followupUuid } from '@/lib/quote/followup-operation-contract'
import { assertFollowupOwned, FollowupError, followupFailure, followupJson, followupTenant,
  getFollowupOperation, postFollowupOperation } from '@/lib/quote/followup-operations'

export const dynamic = 'force-dynamic'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
export async function POST(req: Request) { return postFollowupOperation(db, req, 'note') }
export async function GET(req: Request) {
  if (new URL(req.url).searchParams.has('requestId')) return getFollowupOperation(db, req, 'note')
  try {
    const tenant = await followupTenant(db, req)
    const params = new URL(req.url).searchParams
    const parsed = followupUuid.safeParse(params.get('quoteId'))
    if (!parsed.success || params.size !== 1) throw new FollowupError('invalid_query', 400)
    await assertFollowupOwned(db, tenant.id, { kind: 'quote', id: parsed.data })
    const { data, error } = await db.from('quote_followup_events')
      .select('id,kind,outcome,summary,note,created_at,actor_user_id').eq('tenant_id', tenant.id).eq('quote_id', parsed.data)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(200)
    if (error) throw new FollowupError('followup_unavailable')
    return followupJson({ events: data ?? [] })
  } catch (error) { return followupFailure(error) }
}

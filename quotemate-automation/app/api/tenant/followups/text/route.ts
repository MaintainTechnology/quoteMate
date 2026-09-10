import { createClient } from '@supabase/supabase-js'
import { getFollowupOperation, postFollowupOperation } from '@/lib/quote/followup-operations'

export const dynamic = 'force-dynamic'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
export async function POST(req: Request) { return postFollowupOperation(db, req, 'text') }
export async function GET(req: Request) { return getFollowupOperation(db, req, 'text') }


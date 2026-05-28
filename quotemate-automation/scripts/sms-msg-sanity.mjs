import { createClient } from '@supabase/supabase-js'
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Total messages on the convo we drilled into earlier
const r1 = await supabase
  .from('sms_messages')
  .select('id, direction, body, created_at', { count: 'exact' })
  .eq('conversation_id', '782557da-e3f6-4cf7-adb6-f4475d1a585c')
  .order('created_at', { ascending: false })
  .limit(5)

console.log('convo 782557da messages — count:', r1.count, '  rows returned:', r1.data?.length)
console.log('error:', r1.error)
for (const m of r1.data ?? []) console.log('  ', m.created_at, m.direction, '·', (m.body ?? '').slice(0,100))

// Total messages today (UTC)
const since = '2026-05-28T00:00:00Z'
const r2 = await supabase
  .from('sms_messages')
  .select('conversation_id, direction, body, created_at', { count: 'exact' })
  .gte('created_at', since)
  .order('created_at', { ascending: false })
  .limit(40)

console.log('\nALL messages since 2026-05-28T00 (UTC) — count:', r2.count, '  rows returned:', r2.data?.length)
console.log('error:', r2.error)
for (const m of (r2.data ?? []).slice(0, 25)) {
  console.log('  ', m.created_at.slice(11,19), 'convo='+m.conversation_id.slice(0,8), m.direction, '·', (m.body ?? '').slice(0,90))
}

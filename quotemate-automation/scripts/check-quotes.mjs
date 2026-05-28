import { createClient } from '@supabase/supabase-js'
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const SPARKY = '6dca084c-10d5-4459-b48f-9b45e4bbc68a'
const { data: intakes } = await supabase.from('intakes')
  .select('id, created_at, job_type, scope')
  .eq('tenant_id', SPARKY)
  .order('created_at', { ascending: false }).limit(8)
console.log('=== last 8 Sparky intakes ===')
for (const i of intakes ?? []) {
  console.log(`  ${i.created_at.slice(0,19)}  ${i.id.slice(0,8)}  ${i.job_type}  chosen=${!!i.scope?.chosen_product}`)
}
const { data: quotes } = await supabase.from('quotes')
  .select('id, created_at, intake_id, status, total_inc_gst, routing_decision')
  .eq('tenant_id', SPARKY)
  .order('created_at', { ascending: false }).limit(8)
console.log('\n=== last 8 Sparky quotes ===')
for (const q of quotes ?? []) {
  console.log(`  ${q.created_at.slice(0,19)}  ${q.id.slice(0,8)}  intake=${q.intake_id?.slice(0,8) ?? 'null'}  status=${q.status}  $${q.total_inc_gst}  routing=${q.routing_decision}`)
}

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

// What quotes exist for the 3 intakes we identified?
const intakeIds = [
  'ab04140e', // 27f22f65 had this
  '91a27683', // 782557da had this
]

for (const prefix of intakeIds) {
  const { data: intakes } = await supabase
    .from('intakes')
    .select('id, created_at, trade, job_type, confidence, scope')
    .ilike('id', `${prefix}%`)
  const intake = intakes?.[0]
  if (!intake) { console.log('not found:', prefix); continue }
  console.log(`\n--- intake ${intake.id.slice(0,8)} ---`)
  console.log('  created_at:', intake.created_at)
  console.log('  job_type:', intake.job_type, 'trade:', intake.trade, 'confidence:', intake.confidence)
  console.log('  scope.chosen_product:', !!intake.scope?.chosen_product, '·', intake.scope?.chosen_product?.name ?? '')

  const { data: quotes } = await supabase
    .from('quotes')
    .select('id, created_at, status, total_inc_gst, needs_inspection, routing_decision')
    .eq('intake_id', intake.id)
  console.log(`  quotes for this intake: ${(quotes ?? []).length}`)
  for (const q of quotes ?? []) {
    console.log(`    ${q.created_at.slice(11,19)}  ${q.id.slice(0,8)}  status=${q.status}  total=$${q.total_inc_gst}  routing=${q.routing_decision}`)
  }
}

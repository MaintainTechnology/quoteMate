import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const SPARKY = '6dca084c-10d5-4459-b48f-9b45e4bbc68a'

// Grab the most recent quote — same one as before
const { data: quotes } = await supabase
  .from('quotes')
  .select('id, status, total_inc_gst, needs_inspection, routing_decision, created_at, intake_id, share_token, selected_tier')
  .eq('tenant_id', SPARKY)
  .order('created_at', { ascending: false })
  .limit(1)

const quote = quotes[0]
console.log('=== latest quote ===')
console.log('  id            :', quote.id)
console.log('  created_at    :', quote.created_at)
console.log('  status        :', quote.status)
console.log('  total_inc_gst :', quote.total_inc_gst)
console.log('  intake_id     :', quote.intake_id)
console.log('  needs_inspect :', quote.needs_inspection)
console.log('  routing       :', quote.routing_decision)

const { data: intake } = await supabase
  .from('intakes')
  .select('id, trade, job_type, scope, confidence, tenant_id, created_at, call_id')
  .eq('id', quote.intake_id)
  .single()

console.log('\n=== intake ===')
console.log('  id            :', intake.id)
console.log('  created_at    :', intake.created_at)
console.log('  trade         :', intake.trade)
console.log('  tenant_id     :', intake.tenant_id)
console.log('  job_type      :', intake.job_type)
console.log('  call_id       :', intake.call_id)
console.log('  confidence    :', intake.confidence)
console.log('  scope.chosen_product:', JSON.stringify(intake.scope?.chosen_product ?? null))

const { data: book } = await supabase
  .from('pricing_book')
  .select('id, trade, review_policy, review_threshold_inc_gst, hourly_rate')
  .eq('tenant_id', intake.tenant_id)
  .eq('trade', intake.trade)
  .single()

console.log('\n=== pricing_book for THIS quote (trade='+intake.trade+') ===')
console.log('  policy        :', book.review_policy)
console.log('  threshold     :', book.review_threshold_inc_gst)

const policy = book.review_policy
const total = quote.total_inc_gst
const threshold = book.review_threshold_inc_gst
const isInspection = quote.needs_inspection
const customerAlreadyEngaged = !!intake.scope?.chosen_product
console.log('\n=== shouldHoldForReview inputs ===')
console.log('  policy:', policy, 'total:', total, 'threshold:', threshold, 'isInspection:', isInspection, 'customerAlreadyEngaged:', customerAlreadyEngaged)

let result
if (isInspection === true) result = { hold: false, reason: 'inspection_route_bypasses_gate' }
else if (policy === 'auto_send') result = { hold: false, reason: 'tenant_policy_auto_send' }
else if (policy === 'always_review') {
  if (customerAlreadyEngaged) result = { hold: false, reason: 'customer_already_chose_product' }
  else result = { hold: true, reason: 'tenant_policy_always_review' }
} else if (policy === 'review_over_threshold') {
  if (total >= threshold) result = { hold: true, reason: `total_${total}_at_or_over_threshold_${threshold}` }
  else result = { hold: false, reason: `total_${total}_under_threshold_${threshold}` }
}
console.log('  EXPECTED decision NOW :', result)
console.log('  ACTUAL quote status   :', quote.status)

const { data: convo } = await supabase
  .from('sms_conversations')
  .select('id, from_number, conversation_state')
  .eq('intake_id', intake.id)
  .maybeSingle()

console.log('\n=== sms conversation ===')
console.log('  convo id      :', convo?.id)
console.log('  from_number   :', convo?.from_number)

if (convo) {
  const { data: msgs } = await supabase
    .from('sms_messages')
    .select('direction, body, created_at')
    .eq('conversation_id', convo.id)
    .order('created_at', { ascending: false })
    .limit(8)
  console.log('\n=== last 8 SMS messages on this conversation (most recent first) ===')
  for (const m of msgs ?? []) {
    console.log(`  ${m.created_at}  ${m.direction.padEnd(8)}  ${m.body?.slice(0, 120)}`)
  }
}

// Check if the policy was set AFTER the quote was drafted by looking at the
// pricing_book column timestamp via system catalog. pricing_book has no
// updated_at column, so we can only compare to the quote.created_at.
console.log('\n=== timeline check ===')
console.log('  quote drafted at :', quote.created_at)
console.log('  → If you set the policy AFTER this time, the gate would not have applied to this quote.')

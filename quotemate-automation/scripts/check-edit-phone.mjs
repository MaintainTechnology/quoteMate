import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

const QUOTE_ID = 'db0f7864-253f-420e-b956-c5146863b3d0'

const { data: quote } = await supabase
  .from('quotes')
  .select('id, intake_id, tenant_id, status, total_inc_gst, created_at')
  .eq('id', QUOTE_ID)
  .single()

console.log('=== quote ===')
console.log('  intake_id :', quote.intake_id)
console.log('  status    :', quote.status)
console.log('  total     :', quote.total_inc_gst)
console.log('  created   :', quote.created_at)

const { data: intake } = await supabase
  .from('intakes')
  .select('id, caller, call_id, suburb, job_type, customer_id')
  .eq('id', quote.intake_id)
  .single()

console.log('\n=== intake ===')
console.log('  caller       :', JSON.stringify(intake.caller))
console.log('  call_id      :', intake.call_id)
console.log('  customer_id  :', intake.customer_id)
console.log('  job_type     :', intake.job_type)

// SMS conversation — where the actual phone number lives for SMS quotes
const { data: convo } = await supabase
  .from('sms_conversations')
  .select('id, from_number, conversation_state')
  .eq('intake_id', intake.id)
  .maybeSingle()

console.log('\n=== sms_conversation linked to this intake ===')
console.log('  id          :', convo?.id ?? '(none)')
console.log('  from_number :', convo?.from_number ?? '(none)')

// Customer table fallback
if (intake.customer_id) {
  const { data: customer } = await supabase
    .from('customers')
    .select('id, phone, first_name, last_name')
    .eq('id', intake.customer_id)
    .single()
  console.log('\n=== customer row ===')
  console.log('  phone     :', customer?.phone ?? '(none)')
  console.log('  name      :', customer?.first_name, customer?.last_name)
}

// Voice-path fallback
if (intake.call_id) {
  const { data: call } = await supabase
    .from('calls')
    .select('id, caller_number')
    .eq('id', intake.call_id)
    .single()
  console.log('\n=== call row (voice path) ===')
  console.log('  caller_number:', call?.caller_number ?? '(none)')
}

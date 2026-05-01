// Send a test SMS via seven.io to verify the integration end-to-end.
//
// Usage:
//   node --env-file=.env.local scripts/send-test-sms.mjs +61412345678
//   node --env-file=.env.local scripts/send-test-sms.mjs +61412345678 "custom message"
//
// This sends a REAL SMS — seven.io has no dry-run mode. Every successful
// call costs ~€0.075 and delivers an SMS to the destination phone.

const to = process.argv[2]
const customText = process.argv[3]

if (!to) {
  console.error('Usage: node scripts/send-test-sms.mjs <+E164-number> [message]')
  console.error('Example: node scripts/send-test-sms.mjs +61412345678')
  process.exit(1)
}

if (!to.startsWith('+')) {
  console.error(`✗ Number must be E.164 format starting with + (got: ${to})`)
  console.error('  Example: Australian mobile +61412345678 (drop the leading 0)')
  process.exit(1)
}

const apiKey = process.env.SEVEN_API_KEY
if (!apiKey) {
  console.error('✗ SEVEN_API_KEY not set in environment')
  process.exit(1)
}

const text = customText ?? `QuoteMate test SMS — pipeline reached your phone via seven.io. ${new Date().toISOString().slice(11, 19)} UTC`
const from = process.env.SEVEN_FROM ?? 'QuoteMate'

console.log(`\n→ Sending SMS via seven.io`)
console.log(`  to:   ${to}`)
console.log(`  from: ${from}`)
console.log(`  text: ${text}`)
console.log(``)

const body = new URLSearchParams({ to, text, from, foreign_id: `test-${Date.now()}` })

const res = await fetch('https://gateway.seven.io/api/sms', {
  method: 'POST',
  headers: {
    'X-Api-Key': apiKey,
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: body.toString(),
})

const raw = await res.text()
let parsed
try { parsed = JSON.parse(raw) } catch { parsed = { rawText: raw } }

console.log(`HTTP ${res.status}`)
console.log(JSON.stringify(parsed, null, 2))

if (parsed.success === '100' && parsed.messages?.[0]?.success) {
  const m = parsed.messages[0]
  console.log(``)
  console.log(`✓ SENT — message id ${m.id}`)
  console.log(`  Cost:    €${m.price} (${m.parts} part${m.parts > 1 ? 's' : ''}, ${m.encoding})`)
  console.log(`  Balance: €${parsed.balance}`)
  console.log(``)
  console.log(`Check the destination phone in the next 30 seconds.`)
} else {
  console.error(``)
  console.error(`✗ NOT SENT`)
  console.error(`  Status code: ${parsed.success ?? res.status}`)
  console.error(`  Error:       ${parsed.messages?.[0]?.error ?? '(see body above)'}`)
  process.exit(1)
}

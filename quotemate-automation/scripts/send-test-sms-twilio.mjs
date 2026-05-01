// Send a test SMS via Twilio to verify the integration end-to-end.
//
// Usage:
//   node --env-file=.env.local scripts/send-test-sms-twilio.mjs +61412345678
//   node --env-file=.env.local scripts/send-test-sms-twilio.mjs +61412345678 "custom message"
//
// Sends a REAL SMS — Twilio has no dry-run mode. AU mobile rate ~$0.054 USD.

const to = process.argv[2]
const customText = process.argv[3]

if (!to) {
  console.error('Usage: node scripts/send-test-sms-twilio.mjs <+E164-number> [message]')
  process.exit(1)
}
if (!to.startsWith('+')) {
  console.error(`✗ Number must be E.164 (got: ${to}). Example: +61412345678`)
  process.exit(1)
}

const sid = process.env.TWILIO_ACCOUNT_SID
const token = process.env.TWILIO_AUTH_TOKEN
const from = process.env.TWILIO_PHONE_NUMBER
if (!sid || !token || !from) {
  console.error('✗ Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER')
  process.exit(1)
}

const text = customText ?? `QuoteMate test SMS via Twilio - pipeline reached your phone. ${new Date().toISOString().slice(11, 19)} UTC`

console.log(`\n-> Sending SMS via Twilio`)
console.log(`  to:   ${to}`)
console.log(`  from: ${from}`)
console.log(`  text: ${text}`)
console.log()

const auth = 'Basic ' + Buffer.from(sid + ':' + token).toString('base64')
const body = new URLSearchParams({ To: to, From: from, Body: text })

const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
  method: 'POST',
  headers: {
    Authorization: auth,
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  },
  body: body.toString(),
})

const raw = await res.text()
let parsed
try { parsed = JSON.parse(raw) } catch { parsed = { rawText: raw } }

console.log(`HTTP ${res.status}`)
console.log(JSON.stringify(parsed, null, 2))

if (res.ok && !parsed.error_code) {
  console.log()
  console.log(`✓ ACCEPTED by Twilio`)
  console.log(`  SID:      ${parsed.sid}`)
  console.log(`  Status:   ${parsed.status}  (queued -> sending -> sent -> delivered)`)
  console.log(`  Segments: ${parsed.num_segments}`)
  console.log()
  console.log(`Note: "queued" or "sending" are normal initial states.`)
  console.log(`Check the destination phone in the next 30 seconds.`)
} else {
  console.error()
  console.error(`✗ NOT ACCEPTED`)
  console.error(`  Code:    ${parsed.code ?? parsed.error_code ?? 'n/a'}`)
  console.error(`  Message: ${parsed.message ?? parsed.error_message ?? '(see body above)'}`)
  if (parsed.more_info) console.error(`  Docs:    ${parsed.more_info}`)
  process.exit(1)
}

// Read-only: where does each provisioned Twilio number point its SMS webhook?
import twilio from 'twilio'

const c = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const ns = await c.incomingPhoneNumbers.list({ limit: 30 })
for (const n of ns) {
  console.log(
    `${n.phoneNumber}  sms=${n.smsUrl || '(none)'}  method=${n.smsMethod}  fallback=${n.smsFallbackUrl || '-'}`,
  )
}
console.log(`\n${ns.length} number(s)`)

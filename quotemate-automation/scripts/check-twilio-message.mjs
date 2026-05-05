// ═══════════════════════════════════════════════════════════════════
// QuoteMate · Inspect a Twilio message by SID
//
// Usage:
//   node --env-file=.env.local scripts/check-twilio-message.mjs <SID>
//   node --env-file=.env.local scripts/check-twilio-message.mjs --recent
//
// --recent   prints the last 10 outbound messages on the account so
//            you can see delivery status + any error codes without
//            opening the Twilio console.
// ═══════════════════════════════════════════════════════════════════

import twilio from "twilio";

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
if (!sid || !token) {
  console.error("Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN");
  process.exit(1);
}

const client = twilio(sid, token);
const arg = process.argv[2];

if (!arg) {
  console.error('Usage: ... check-twilio-message.mjs <SID> | --recent');
  process.exit(1);
}

if (arg === "--recent") {
  console.log("\n→ Last 10 messages on this account:\n");
  const msgs = await client.messages.list({ limit: 10 });
  for (const m of msgs) {
    const ts = m.dateUpdated.toISOString().slice(11, 19);
    const dir = m.direction.padEnd(18);
    const status = (m.status ?? "").padEnd(11);
    const err = m.errorCode ? `err=${m.errorCode}` : "";
    console.log(`  ${ts}  ${m.sid.slice(0, 14)}…  ${dir}  ${status}  ${m.from} → ${m.to}  ${err}`);
    if (m.errorMessage) console.log(`              ${m.errorMessage}`);
  }
  console.log();
  process.exit(0);
}

// Fetch a single message by SID
console.log(`\n→ Fetching ${arg} ...\n`);
try {
  const m = await client.messages(arg).fetch();
  console.log(`  sid:           ${m.sid}`);
  console.log(`  direction:     ${m.direction}`);
  console.log(`  status:        ${m.status}`);
  console.log(`  from:          ${m.from}`);
  console.log(`  to:            ${m.to}`);
  console.log(`  date sent:     ${m.dateSent}`);
  console.log(`  date updated:  ${m.dateUpdated}`);
  console.log(`  body:          "${(m.body ?? '').slice(0, 100)}"`);
  console.log(`  error code:    ${m.errorCode ?? '(none)'}`);
  console.log(`  error msg:     ${m.errorMessage ?? '(none)'}`);
  console.log(`  num segments:  ${m.numSegments}`);
  console.log(`  price:         ${m.price ?? '(unset)'} ${m.priceUnit ?? ''}`);
} catch (err) {
  console.error(`✗ Failed: ${err.message}`);
  process.exit(1);
}

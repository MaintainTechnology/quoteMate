// Dump both the customers row and the conversation_state for a phone
// number. Used to verify mid-conversation correction persistence.
//
// Usage:
//   node --env-file=.env.local scripts/check-customer-and-state.mjs --phone +61489083371

import pg from "pg";

const { Client } = pg;
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) { console.error("Missing SUPABASE_DB_URL"); process.exit(1); }

const i = process.argv.indexOf("--phone");
const phone = i >= 0 ? process.argv[i + 1] : null;
if (!phone) { console.error("Need --phone +61XXXXXXXXX"); process.exit(1); }

const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log("═══ CUSTOMERS row ═══");
const cust = await client.query(
  `select id, phone_number, first_name, suburb, address, email, updated_at
     from customers where phone_number = $1`,
  [phone],
);
if (cust.rows.length === 0) console.log("(no row)");
else console.log(JSON.stringify(cust.rows[0], null, 2));

console.log("\n═══ CONVERSATION_STATE (most recent) ═══");
const conv = await client.query(
  `select id, status, turn_count, conversation_state, last_message_at, updated_at
     from sms_conversations
     where from_number = $1
     order by last_message_at desc limit 1`,
  [phone],
);
if (conv.rows.length === 0) console.log("(no row)");
else {
  const c = conv.rows[0];
  console.log(`id=${c.id} status=${c.status} turns=${c.turn_count}`);
  console.log("conversation_state:");
  console.log(JSON.stringify(c.conversation_state, null, 2));
}

await client.end();

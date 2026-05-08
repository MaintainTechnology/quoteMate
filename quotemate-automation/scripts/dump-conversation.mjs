// ═══════════════════════════════════════════════════════════════════
// QuoteMate · SMS conversation dump (full message bodies, untruncated)
//
// Usage:
//   node --env-file=.env.local scripts/dump-conversation.mjs
//   node --env-file=.env.local scripts/dump-conversation.mjs --phone +61XXXXXXXXX
//   node --env-file=.env.local scripts/dump-conversation.mjs --id <conversation-uuid>
//   node --env-file=.env.local scripts/dump-conversation.mjs --last 3
//
// Prints the FULL body of every message in a conversation, with byte
// length and Twilio SID. Use this to confirm what was actually
// dispatched when the customer's phone shows weird segment rendering
// (e.g. just "- QuoteMate" appearing as a separate bubble).
// ═══════════════════════════════════════════════════════════════════

import pg from "pg";

const { Client } = pg;
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

// ─── Args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const phone = getArg("--phone");
const convId = getArg("--id");
const lastN = parseInt(getArg("--last") ?? "1", 10);

const client = new Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

// ─── Resolve which conversation(s) to dump ───────────────────────────
let conversationIds = [];

if (convId) {
  conversationIds = [convId];
} else if (phone) {
  const { rows } = await client.query(
    `select id from sms_conversations
       where from_number = $1
       order by last_message_at desc nulls last
       limit $2`,
    [phone, lastN],
  );
  conversationIds = rows.map((r) => r.id);
} else {
  const { rows } = await client.query(
    `select id from sms_conversations
       order by last_message_at desc nulls last
       limit $1`,
    [lastN],
  );
  conversationIds = rows.map((r) => r.id);
}

if (conversationIds.length === 0) {
  console.log("No conversations found.");
  await client.end();
  process.exit(0);
}

// ─── Dump each conversation ──────────────────────────────────────────
for (const id of conversationIds) {
  const { rows: conv } = await client.query(
    `select id, from_number, to_number, status, turn_count,
            assumptions_made, photo_request_sent_at, photos_completed_at,
            photo_urls, photo_paths,
            created_at, last_message_at, updated_at, processing_until
       from sms_conversations
       where id = $1`,
    [id],
  );

  if (conv.length === 0) {
    console.log(`\n[!] No conversation with id=${id}`);
    continue;
  }
  const c = conv[0];

  console.log("\n" + "═".repeat(72));
  console.log(`CONVERSATION  ${c.id}`);
  console.log("═".repeat(72));
  console.log(`from:    ${c.from_number}`);
  console.log(`to:      ${c.to_number}`);
  console.log(`status:  ${c.status}    turns: ${c.turn_count}`);
  console.log(`created: ${c.created_at?.toISOString?.() ?? c.created_at}`);
  console.log(`last:    ${c.last_message_at?.toISOString?.() ?? c.last_message_at}`);
  if (c.processing_until) {
    console.log(`lock:    processing_until=${c.processing_until.toISOString?.() ?? c.processing_until}`);
  }
  if (c.photo_request_sent_at) {
    console.log(`photo:   request_sent=${c.photo_request_sent_at.toISOString?.() ?? c.photo_request_sent_at}` +
                (c.photos_completed_at
                  ? `   completed=${c.photos_completed_at.toISOString?.() ?? c.photos_completed_at}`
                  : ``));
  }
  if (c.photo_urls?.length) {
    console.log(`photos:  ${c.photo_urls.length} url(s) on conversation`);
  }
  if (c.assumptions_made?.length) {
    console.log(`assumptions:`);
    for (const a of c.assumptions_made) console.log(`  - ${a}`);
  }

  const { rows: msgs } = await client.query(
    `select id, direction, body, twilio_message_sid, created_at,
            photo_urls, photo_paths
       from sms_messages
       where conversation_id = $1
       order by created_at asc`,
    [id],
  );

  console.log(`\nMESSAGES  (${msgs.length} total)\n`);

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const ts = m.created_at?.toISOString?.() ?? m.created_at;
    const dir = m.direction.toUpperCase();
    const arrow = m.direction === "inbound" ? "← IN " : "→ OUT";
    const sid = m.twilio_message_sid ?? "(no sid)";
    const len = (m.body ?? "").length;

    // Estimate SMS segment count (GSM-7: 160 chars/segment, 153 in concatenated).
    // Anything over 160 will be multi-segment on the customer's phone.
    const looksGsm7 = /^[\x20-\x7E\n\r]*$/.test(m.body ?? "");
    const segCount = !looksGsm7
      ? Math.ceil(len / 70)        // UCS-2: 70 chars/segment
      : len <= 160 ? 1
      : Math.ceil(len / 153);

    console.log("─".repeat(72));
    console.log(`#${(i + 1).toString().padStart(2)} ${arrow}  ${ts}`);
    console.log(`     sid=${sid}   bytes=${len}   segments≈${segCount}${looksGsm7 ? " (GSM-7)" : " (UCS-2)"}`);
    if (m.photo_urls?.length) {
      console.log(`     photos: ${m.photo_urls.length} attachment(s)`);
    }
    console.log("");
    // Print body verbatim, indented so it's visually distinct from headers.
    const body = m.body ?? "(empty)";
    for (const line of body.split("\n")) {
      console.log(`     │ ${line}`);
    }
    console.log("");
  }
}

await client.end();

// Verifies the booking-flow schema is live in Supabase before /q/[token]/book
// is shipped. Reports missing columns + the tradies row state. Read-only.
//
// Usage:  node --env-file=.env.local scripts/check-booking-schema.mjs

import pg from "pg";
const { Client } = pg;

const REQUIRED = [
  ["tradies", "available_slots"],
  ["tradies", "business_name"],
  ["quotes",  "scheduled_at"],
  ["quotes",  "accepted_at"],
  ["quotes",  "accepted_tier"],
  ["quotes",  "status"],
  ["quotes",  "share_token"],
  ["quotes",  "paid_at"],
  ["quotes",  "paid_tier"],
];

const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
console.log("→ Connected to Supabase Postgres\n");

let missing = 0;
console.log("Schema columns:");
for (const [table, col] of REQUIRED) {
  const { rows } = await client.query(
    `select count(*)::int as n from information_schema.columns where table_name=$1 and column_name=$2`,
    [table, col]
  );
  const ok = rows[0].n === 1;
  console.log(`  ${ok ? "✓" : "✗"} ${table}.${col}${ok ? "" : "   MISSING"}`);
  if (!ok) missing++;
}

console.log("");

const { rows: tradieRows } = await client.query(
  `select id, business_name,
          jsonb_array_length(coalesce(available_slots, '[]'::jsonb)) as slot_count
     from tradies order by created_at asc`
);

if (tradieRows.length === 0) {
  console.log("Tradies: 0 rows  (booking page will fall through to 'we'll be in touch')");
} else {
  console.log(`Tradies: ${tradieRows.length} row(s)`);
  for (const r of tradieRows) {
    console.log(`  - ${r.business_name ?? "(unnamed)"}  slots=${r.slot_count}  id=${r.id}`);
  }
}

console.log("");
if (missing > 0) {
  console.log(`⚠  ${missing} column(s) missing — run sql/04_f3_finish.sql before deploying booking page.`);
  process.exitCode = 1;
} else {
  console.log("✓ Schema OK for booking flow.");
}

await client.end();

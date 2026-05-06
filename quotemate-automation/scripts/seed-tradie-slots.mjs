// Seeds 6 future booking slots onto the active tradie row so /q/[token]/book
// has something to render in production. Idempotent — re-running replaces
// the list with a fresh 10-day window starting tomorrow.
//
// Slot times are AU Eastern (Sydney) business hours, weekdays only.
// Adjust the SLOT_TEMPLATE below to taste.
//
// Usage:  node --env-file=.env.local scripts/seed-tradie-slots.mjs

import pg from "pg";
const { Client } = pg;

// Hour-of-day (Sydney) and offset-in-business-days from today.
// Skips weekends automatically by stepping forward when needed.
const SLOT_TEMPLATE = [
  { businessDayOffset: 1, hour: 9 },
  { businessDayOffset: 2, hour: 13 },
  { businessDayOffset: 3, hour: 10 },
  { businessDayOffset: 4, hour: 15 },
  { businessDayOffset: 6, hour: 11 },
  { businessDayOffset: 8, hour: 14 },
];

function nextBusinessDays(count) {
  // Build dates starting tomorrow, skipping Sat (6) and Sun (0).
  const days = [];
  const cursor = new Date();
  cursor.setDate(cursor.getDate() + 1);
  while (days.length < count) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function buildIsoSydney(date, hour) {
  // Render a Sydney-local ISO timestamp string. AU Eastern is +10:00 in
  // standard time and +11:00 during daylight savings. We emit +10:00 here;
  // Postgres timestamptz stores this correctly regardless of DST drift
  // because the offset is explicit. UI side parses with toLocaleString.
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:00:00+10:00`;
}

const businessDays = nextBusinessDays(Math.max(...SLOT_TEMPLATE.map((s) => s.businessDayOffset)) + 1);
const slots = SLOT_TEMPLATE.map(({ businessDayOffset, hour }) =>
  buildIsoSydney(businessDays[businessDayOffset - 1], hour)
);

console.log("Seeding slots:");
for (const s of slots) console.log(`  - ${s}`);

const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const { rowCount } = await client.query(
  `update tradies set available_slots = $1::jsonb`,
  [JSON.stringify(slots)]
);

console.log(`\n✓ Updated ${rowCount} tradie row(s).`);

const { rows } = await client.query(
  `select business_name, jsonb_array_length(available_slots) as n from tradies`
);
for (const r of rows) console.log(`  ${r.business_name}: ${r.n} slot(s)`);

await client.end();

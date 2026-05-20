// Inspect orphan calls with non-UUID vapi_call_id (the 10 API-error calls).

import pg from "pg";
const { Client } = pg;
const c = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows } = await c.query(`
  select id, vapi_call_id, caller_number, duration_seconds, recording_url, created_at
    from calls
   where tenant_id is null
     and vapi_call_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   order by created_at`);
console.log(`Non-UUID vapi_call_id (${rows.length} rows):`);
for (const r of rows) {
  console.log(`  id=${r.id}`);
  console.log(`    vapi_call_id="${r.vapi_call_id}"`);
  console.log(`    caller=${r.caller_number}  duration=${r.duration_seconds}s  recording=${r.recording_url ? "yes" : "no"}  created=${r.created_at.toISOString()}`);
}
await c.end();

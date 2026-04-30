import pg from "pg";
const { Client } = pg;
const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();

const { rows: calls } = await c.query(
  `select id, vapi_call_id, ended_at, length(transcript) as transcript_len from calls order by ended_at desc nulls last limit 5`
);
console.log("\n[calls — most recent 5]");
console.table(calls);

const callIds = calls.map(r => r.id);
if (callIds.length) {
  const { rows: intakes } = await c.query(
    `select id, call_id, job_type, confidence, created_at from intakes where call_id = any($1::uuid[]) order by created_at desc`,
    [callIds]
  );
  console.log("\n[intakes for those calls]");
  console.table(intakes);

  if (intakes.length) {
    const intakeIds = intakes.map(r => r.id);
    const { rows: quotes } = await c.query(
      `select id, intake_id, status, total_inc_gst, created_at from quotes where intake_id = any($1::uuid[]) order by created_at desc`,
      [intakeIds]
    );
    console.log("\n[quotes for those intakes]");
    console.table(quotes);
  }
}

await c.end();

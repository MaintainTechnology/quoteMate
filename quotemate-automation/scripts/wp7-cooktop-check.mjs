// READ-ONLY one-off — is induction/cooktop a catalogue extra, and is it
// enabled for the Sparky tenant?
import pg from "pg";
const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: sa } = await c.query(
  `select id, name, trade, default_enabled
     from shared_assemblies
    where name ilike '%induction%' or name ilike '%cooktop%'
       or name ilike '%oven%' or name ilike '%hotplate%'
    order by name`,
);
console.log(`shared_assemblies (induction/cooktop/oven) — ${sa.length}:`);
for (const r of sa)
  console.log(
    `  ${r.name} (${r.trade}) default_enabled=${r.default_enabled}`,
  );
const t = (
  await c.query(`select id from tenants where twilio_sms_number = $1`, [
    "+61468048422",
  ])
).rows[0];
if (t && sa.length) {
  const ids = sa.map((r) => r.id);
  const off = (
    await c.query(
      `select sa.name, tso.enabled
         from tenant_service_offerings tso
         join shared_assemblies sa on sa.id = tso.assembly_id
        where tso.tenant_id = $1 and tso.assembly_id = any($2)`,
      [t.id, ids],
    )
  ).rows;
  console.log(`\nSparky offering state:`);
  if (off.length === 0)
    console.log("  (no rows — shows catalogue default, i.e. OFF)");
  for (const r of off) console.log(`  ${r.name} :: enabled=${r.enabled}`);
}
await c.end();

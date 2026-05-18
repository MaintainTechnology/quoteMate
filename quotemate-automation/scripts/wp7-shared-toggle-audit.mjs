// READ-ONLY — are dishwasher/disposal SHARED catalogue items, and is the
// Sparky tenant's tenant_service_offerings toggle honoured by the AI?
import pg from "pg";
const { Client } = pg;
const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
try {
  await client.connect();

  const { rows: sa } = await client.query(
    `select id, name, trade, default_enabled
       from shared_assemblies
      where name ilike '%dishwash%' or name ilike '%disposal%'
         or name ilike '%insinkerat%' or name ilike '%waste%'
      order by trade, name`,
  );
  console.log(`\nshared_assemblies matching dishwasher/disposal (${sa.length}):`);
  for (const r of sa)
    console.log(`  ${r.name} (${r.trade}) default_enabled=${r.default_enabled} id=${r.id}`);

  const { rows: tenant } = await client.query(
    `select id, business_name from tenants where twilio_sms_number = '+61468048422'`,
  );
  if (tenant.length === 0) {
    console.log("\nSparky tenant not found by number.");
    process.exit(0);
  }
  const tid = tenant[0].id;
  console.log(`\nSparky tenant id=${tid}`);

  const saIds = sa.map((r) => r.id);
  if (saIds.length) {
    const { rows: off } = await client.query(
      `select tso.assembly_id, sa.name, tso.enabled
         from tenant_service_offerings tso
         join shared_assemblies sa on sa.id = tso.assembly_id
        where tso.tenant_id = $1 and tso.assembly_id = any($2)`,
      [tid, saIds],
    );
    console.log(
      `\ntenant_service_offerings rows for those items (${off.length}):`,
    );
    for (const r of off)
      console.log(`  ${r.name} :: enabled=${r.enabled}`);
    if (off.length === 0)
      console.log("  (no offering rows → dashboard shows catalogue default)");
  }

  const { rows: tot } = await client.query(
    `select count(*)::int n, sum((enabled)::int)::int en
       from tenant_service_offerings where tenant_id = $1`,
    [tid],
  );
  console.log(
    `\nSparky total service offerings: ${tot[0].n} rows, ${tot[0].en} enabled`,
  );
  console.log(
    "\nKEY POINT: the SMS dialog scope is the HARD-CODED easy-5 +\n" +
      "tenant_custom_assemblies ONLY. It does NOT read shared_assemblies\n" +
      "or tenant_service_offerings — so toggling a SHARED catalogue item\n" +
      "(dishwasher/disposal) ON has NO effect on what the AI will quote.",
  );
} catch (e) {
  console.error("failed:", e.message ?? e);
  process.exit(1);
} finally {
  await client.end();
}

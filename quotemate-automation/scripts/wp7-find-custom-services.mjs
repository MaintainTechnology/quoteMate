// READ-ONLY — where do "dishwasher"/"garbage disposal" custom services live?
// Usage: node --env-file=.env.local scripts/wp7-find-custom-services.mjs
import pg from "pg";
const { Client } = pg;
const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});
try {
  await client.connect();
  const { rows } = await client.query(
    `select t.business_name, t.twilio_sms_number, tca.name, tca.trade,
            tca.enabled, tca.always_inspection
       from tenant_custom_assemblies tca
       join tenants t on t.id = tca.tenant_id
      order by t.business_name, tca.name`,
  );
  console.log(`\nAll tenant_custom_assemblies across every tenant (${rows.length}):`);
  if (rows.length === 0) console.log("  (NONE anywhere in the database)");
  for (const r of rows) {
    console.log(
      `  ${r.business_name} [${r.twilio_sms_number}] :: ${r.name} (${r.trade}) ` +
        `enabled=${r.enabled} always_inspection=${r.always_inspection}`,
    );
  }
} catch (e) {
  console.error("failed:", e.message ?? e);
  process.exit(1);
} finally {
  await client.end();
}

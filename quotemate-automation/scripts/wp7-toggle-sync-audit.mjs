// READ-ONLY diagnostic — is the Services toggle in sync with the SMS AI?
// Usage: node --env-file=.env.local scripts/wp7-toggle-sync-audit.mjs [last9digits]
//
// Resolves the tenant by its twilio_sms_number, then prints:
//   1. the tenant's tenant_custom_assemblies (name / trade / enabled /
//      always_inspection)  ← what the AI dialog is fed (enabled only)
//   2. the most recent sms_conversations for that tenant (status,
//      last_message_at, processing_until)  ← explains the "wrapping up
//      the quote" canned-hold-on loop
// No writes. Safe to run against production.

import pg from "pg";

const { Client } = pg;
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

// Agent number from the transcript: 0468 048 422 → core 468048422.
const want = (process.argv[2] || "468048422").replace(/\D/g, "").slice(-9);

const client = new Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();

  const { rows: tenants } = await client.query(
    `select id, business_name, trade, trades, twilio_sms_number, status
       from tenants
      where twilio_sms_number is not null`,
  );
  const tenant = tenants.find(
    (t) => (t.twilio_sms_number || "").replace(/\D/g, "").slice(-9) === want,
  );
  if (!tenant) {
    console.log(
      `No tenant whose twilio_sms_number ends with ${want}. Numbers on file:`,
    );
    for (const t of tenants) {
      console.log(`  ${t.twilio_sms_number}  ${t.business_name}`);
    }
    process.exit(0);
  }

  console.log("\n=== TENANT ===");
  console.log(
    `  ${tenant.business_name}  id=${tenant.id}\n  trades=${JSON.stringify(
      tenant.trades,
    )}  number=${tenant.twilio_sms_number}  status=${tenant.status}`,
  );

  const { rows: customs } = await client.query(
    `select name, trade, enabled, always_inspection, updated_at
       from tenant_custom_assemblies
      where tenant_id = $1
      order by enabled desc, trade, name`,
    [tenant.id],
  );
  console.log(
    `\n=== tenant_custom_assemblies (${customs.length}) — what the AI is told ===`,
  );
  if (customs.length === 0) {
    console.log(
      "  (none) → AI has NO custom services for this tenant. 'dishwasher'\n" +
        "  will always be refused as out-of-scope. Either none were created,\n" +
        "  or they were created under a different tenant.",
    );
  }
  for (const c of customs) {
    const flag = c.enabled
      ? c.always_inspection
        ? "ENABLED · inspection-only"
        : "ENABLED · auto-quote"
      : "OFF (hidden from AI)";
    console.log(
      `  [${flag}] ${c.name}  (${c.trade})  updated ${
        c.updated_at?.toISOString?.() ?? c.updated_at
      }`,
    );
  }
  const enabledCount = customs.filter((c) => c.enabled).length;
  console.log(
    `\n  → ${enabledCount} enabled row(s) would be injected into the SMS dialog scope.`,
  );

  const { rows: convos } = await client.query(
    `select id, from_number, status, last_message_at, processing_until,
            intake_id, turn_count
       from sms_conversations
      where tenant_id = $1
      order by last_message_at desc nulls last
      limit 6`,
    [tenant.id],
  );
  console.log(`\n=== recent sms_conversations (${convos.length}) ===`);
  for (const c of convos) {
    const ageS = c.last_message_at
      ? Math.round((Date.now() - new Date(c.last_message_at).getTime()) / 1000)
      : null;
    console.log(
      `  ${c.from_number}  status=${c.status}  turns=${c.turn_count}  ` +
        `last_msg=${ageS === null ? "?" : ageS + "s ago"}  ` +
        `intake=${c.intake_id ? "yes" : "no"}  ` +
        `processing_until=${c.processing_until ?? "null"}`,
    );
  }
  console.log(
    "\nNote: status='done' within 60s triggers the canned \"just wrapping\n" +
      'up the quote" reply AND skips the AI entirely — even when the\n' +
      "conversation only escalated to inspection (no quote exists).",
  );
} catch (err) {
  console.error("Audit failed:", err.message ?? err);
  process.exit(1);
} finally {
  await client.end();
}

// Vapi orphan-call audit + backfill.
//
// For each call with tenant_id IS NULL, query the Vapi API to get its
// assistantId, then match against tenants.vapi_assistant_id to back-fill.
// DRY RUN by default; pass --apply to write the UPDATEs.
//
// Calls without resolvable attribution stay NULL (no historical assistant
// match) — documented as truly unrecoverable.
//
// Rate: 49 calls sequenced with a 200ms delay = ~10s total. Vapi's
// documented rate limit is generous (60 req/sec); the delay is courtesy.

import pg from "pg";
const { Client } = pg;

const VAPI_API = "https://api.vapi.ai";
const apiKey = process.env.VAPI_API_KEY;
if (!apiKey) {
  console.error("Missing VAPI_API_KEY in .env.local");
  process.exit(1);
}

const c = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchVapiCall(vapiCallId) {
  try {
    const res = await fetch(`${VAPI_API}/call/${vapiCallId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: await res.text().catch(() => "<no body>") };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message ?? String(e) };
  }
}

try {
  await c.connect();

  // 1. Pull orphan calls + the tenant assistant-id map
  const { rows: orphans } = await c.query(`
    select id, vapi_call_id, caller_number, created_at
      from calls
     where tenant_id is null
     order by created_at desc`);
  const { rows: tenants } = await c.query(`
    select id, business_name, vapi_assistant_id, created_at
      from tenants
     where vapi_assistant_id is not null`);

  console.log(`─── Vapi orphan audit ──────────────────────────────────`);
  console.log(`  Orphan calls:                     ${orphans.length}`);
  console.log(`  Tenants with vapi_assistant_id:   ${tenants.length}`);
  for (const t of tenants)
    console.log(`    ${t.business_name.padEnd(20)} ${t.vapi_assistant_id} (created ${t.created_at.toISOString().slice(0, 10)})`);

  const tenantByAssistant = new Map(tenants.map((t) => [t.vapi_assistant_id, t]));

  // 2. Query Vapi for each orphan
  console.log(`\n─── Pulling assistantId from Vapi for each call ───────`);
  const results = [];
  let resolved = 0;
  let notFound = 0;
  let apiErr = 0;
  let unmatched = 0;

  for (const o of orphans) {
    if (!o.vapi_call_id) {
      results.push({ call: o, status: "no_vapi_call_id" });
      continue;
    }
    const r = await fetchVapiCall(o.vapi_call_id);
    if (!r.ok) {
      if (r.status === 404) {
        notFound++;
        results.push({ call: o, status: "vapi_404" });
      } else {
        apiErr++;
        results.push({ call: o, status: "api_err", error: r.error });
      }
      await sleep(200);
      continue;
    }
    const assistantId = r.data.assistantId ?? r.data.assistant?.id ?? null;
    if (!assistantId) {
      results.push({ call: o, status: "no_assistant", vapiData: r.data });
      await sleep(200);
      continue;
    }
    const tenant = tenantByAssistant.get(assistantId);
    if (!tenant) {
      unmatched++;
      results.push({ call: o, status: "assistant_unmatched", assistantId });
    } else {
      resolved++;
      results.push({ call: o, status: "resolved", tenantId: tenant.id, tenantName: tenant.business_name, assistantId });
    }
    await sleep(200);
  }

  // 3. Summary
  console.log(`\n─── Summary ────────────────────────────────────────────`);
  console.log(`  Resolvable (assistant matched a tenant):  ${resolved}`);
  console.log(`  Unmatched (assistant has no tenant row):  ${unmatched}`);
  console.log(`  Vapi 404 (call no longer in Vapi):        ${notFound}`);
  console.log(`  Vapi API errors:                          ${apiErr}`);

  if (resolved > 0) {
    console.log(`\n─── Resolvable detail ──────────────────────────────────`);
    const byTenant = new Map();
    for (const r of results.filter((x) => x.status === "resolved")) {
      const k = r.tenantName;
      byTenant.set(k, (byTenant.get(k) ?? 0) + 1);
    }
    for (const [name, count] of byTenant) console.log(`    ${name.padEnd(22)} ${count} calls`);
  }

  if (unmatched > 0) {
    const unmatchedAssistants = new Map();
    for (const r of results.filter((x) => x.status === "assistant_unmatched")) {
      unmatchedAssistants.set(r.assistantId, (unmatchedAssistants.get(r.assistantId) ?? 0) + 1);
    }
    console.log(`\n─── Unmatched assistant IDs (orphan side) ──────────────`);
    for (const [aid, count] of unmatchedAssistants)
      console.log(`    ${aid.padEnd(40)} ${count} calls`);
    console.log(`  → These assistants exist on Vapi but have no tenants row matching them.`);
    console.log(`    Probably the pre-multi-tenant single assistant. Cannot attribute.`);
  }

  if (apiErr > 0) {
    console.log(`\n─── API error detail ───────────────────────────────────`);
    const byStatus = new Map();
    for (const r of results.filter((x) => x.status === "api_err")) {
      const k = `status=${r.error?.status ?? "?"}`;
      byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
    }
    for (const [k, n] of byStatus) console.log(`    ${k.padEnd(20)} ${n}`);
    // Print up to 3 sample raw error strings (truncated)
    const samples = results.filter((x) => x.status === "api_err").slice(0, 3);
    for (const s of samples) {
      const e = typeof s.error === "string" ? s.error : JSON.stringify(s.error);
      console.log(`    sample: ${e.slice(0, 120)}`);
    }
  }

  // 4. Apply or dry-run
  if (!APPLY) {
    console.log(`\nDRY RUN — re-run with --apply to write the UPDATEs.`);
    process.exit(0);
  }
  if (resolved === 0) {
    console.log(`\nNo resolvable rows — nothing to apply.`);
    process.exit(0);
  }

  console.log(`\n→ Applying ${resolved} backfills (transactional)...`);
  await c.query("begin");
  let updated = 0;
  for (const r of results.filter((x) => x.status === "resolved")) {
    const res = await c.query(
      `update calls set tenant_id = $1 where id = $2 and tenant_id is null`,
      [r.tenantId, r.call.id],
    );
    updated += res.rowCount;
  }
  await c.query("commit");
  console.log(`  ✓ updated ${updated} calls`);

  // 5. Cascade FK propagation to intakes (only those whose parent call just got resolved)
  console.log(`\n→ Cascading intakes ← newly-resolved calls...`);
  await c.query("begin");
  const cascade = await c.query(`
    update intakes i
       set tenant_id = ca.tenant_id
      from calls ca
     where ca.id = i.call_id
       and i.tenant_id is null
       and ca.tenant_id is not null`);
  console.log(`  ✓ intakes ← calls:  ${cascade.rowCount} rows`);
  const cascade2 = await c.query(`
    update quotes q
       set tenant_id = i.tenant_id
      from intakes i
     where i.id = q.intake_id
       and q.tenant_id is null
       and i.tenant_id is not null`);
  console.log(`  ✓ quotes  ← intakes: ${cascade2.rowCount} rows`);
  await c.query("commit");

  // 6. Final state
  const { rows: final } = await c.query(`
    select 'calls' t, count(*) filter (where tenant_id is null)::int n, count(*)::int total from calls union all
    select 'intakes', count(*) filter (where tenant_id is null)::int, count(*)::int from intakes union all
    select 'quotes', count(*) filter (where tenant_id is null)::int, count(*)::int from quotes`);
  console.log(`\n─── Final orphan counts ────────────────────────────────`);
  for (const r of final) console.log(`  ${r.t.padEnd(10)} NULL ${String(r.n).padStart(4)} / ${r.total}`);
  console.log(`\nOK — Vapi audit complete.`);
} catch (e) {
  try { await c.query("rollback"); } catch {}
  console.error("FAILED:", e.message ?? e);
  process.exit(1);
} finally {
  await c.end();
}

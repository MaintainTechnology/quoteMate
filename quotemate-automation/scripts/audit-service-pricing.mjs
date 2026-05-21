// READ-ONLY pricing-completeness audit.
//
// Question being answered: "Do all services on the dashboard Services tab
// have the pricing data the estimator needs, so the AI never has to invent
// a price?"
//
// Grounding model (lib/estimate/validate.ts): a quote line is only accepted
// if its unit price traces to a real DB row — shared_assemblies /
// shared_materials price (× markup band), OR pricing_book hourly /
// apprentice / senior rate (labour), OR pricing_book call_out_minimum.
// Anything else downgrades the WHOLE quote to a $99 inspection. So
// "invented pricing" is structurally impossible; the real risk is a
// service with INCOMPLETE pricing silently failing grounding and routing
// to inspection. This audit finds those.
//
// A shared/custom assembly is auto-quoteable when it has EITHER:
//   - a positive default_unit_price_ex_gst (fixed/material line), OR
//   - positive default_labour_hours (pure-labour line vs hourly_rate).
// With NEITHER it can never produce a grounded line.

import pg from "pg";
const { Client } = pg;
const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

const colsOf = async (table) => {
  const { rows } = await client.query(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name=$1`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
};
const has = (set, c) => set.has(c);
const pos = (v) => v !== null && v !== undefined && Number(v) > 0;

try {
  await client.connect();

  // ─── 1. pricing_book coverage per active tenant × trade ────────────
  const pbCols = await colsOf("pricing_book");
  console.log("=".repeat(72));
  console.log("1. PRICING_BOOK — labour/markup basis per tenant × trade");
  console.log("=".repeat(72));
  const tenantTradeCol = has(pbCols, "trade");
  const { rows: tenants } = await client.query(
    `select id, business_name, status, trade, trades from tenants order by business_name`,
  );
  const pbSel = [
    "id",
    has(pbCols, "tenant_id") ? "tenant_id" : "null::uuid as tenant_id",
    tenantTradeCol ? "trade" : "'(no trade col)'::text as trade",
    "hourly_rate",
    has(pbCols, "apprentice_rate") ? "apprentice_rate" : "null as apprentice_rate",
    has(pbCols, "senior_rate") ? "senior_rate" : "null as senior_rate",
    "call_out_minimum",
    "default_markup_pct",
    has(pbCols, "min_labour_hours") ? "min_labour_hours" : "null as min_labour_hours",
  ].join(", ");
  const { rows: books } = await client.query(`select ${pbSel} from pricing_book`);
  const bookKey = (t, trade) => `${t}|${trade}`;
  const bookMap = new Map();
  for (const b of books) bookMap.set(bookKey(b.tenant_id, b.trade), b);

  for (const t of tenants) {
    const trades =
      Array.isArray(t.trades) && t.trades.length ? t.trades : t.trade ? [t.trade] : [];
    console.log(`\n  ${t.business_name} [${t.status}] trades=${JSON.stringify(trades)}`);
    for (const tr of trades) {
      const b = bookMap.get(bookKey(t.id, tr));
      if (!b) {
        console.log(`    ✗ ${tr}: NO pricing_book row → every ${tr} quote fails grounding`);
        continue;
      }
      const probs = [];
      if (!pos(b.hourly_rate)) probs.push(`hourly_rate=${b.hourly_rate}`);
      if (!pos(b.call_out_minimum)) probs.push(`call_out_minimum=${b.call_out_minimum}`);
      if (b.default_markup_pct === null) probs.push(`default_markup_pct=null`);
      if (!pos(b.apprentice_rate)) probs.push(`apprentice_rate=${b.apprentice_rate}`);
      const note =
        b.min_labour_hours === null ? "  (min_labour_hours null → validator default 2.0)" : "";
      console.log(
        probs.length
          ? `    ✗ ${tr}: ${probs.join(", ")}`
          : `    ✓ ${tr}: hourly=$${b.hourly_rate} callout=$${b.call_out_minimum} markup=${b.default_markup_pct}% appr=$${b.apprentice_rate} senior=${b.senior_rate ?? "—"}${note}`,
      );
    }
  }

  // ─── 2. shared_assemblies — price basis ────────────────────────────
  const saCols = await colsOf("shared_assemblies");
  const saSel = [
    "id",
    "name",
    "trade",
    has(saCols, "default_unit") ? "default_unit" : "null as default_unit",
    "default_unit_price_ex_gst as price",
    "default_labour_hours as labour",
    has(saCols, "default_enabled") ? "default_enabled" : "true as default_enabled",
    has(saCols, "category") ? "category" : "null as category",
  ].join(", ");
  const { rows: sa } = await client.query(
    `select ${saSel} from shared_assemblies order by trade, name`,
  );
  console.log("\n" + "=".repeat(72));
  console.log(`2. SHARED_ASSEMBLIES — ${sa.length} rows`);
  console.log("=".repeat(72));
  const bucket = (r) => {
    const p = pos(r.price), l = pos(r.labour);
    if (p && l) return "full (price + labour)";
    if (p && !l) return "fixed-price only";
    if (!p && l) return "labour-only";
    return "NO PRICE BASIS";
  };
  const byTrade = {};
  for (const r of sa) {
    (byTrade[r.trade] ??= []).push(r);
  }
  for (const [trade, rows] of Object.entries(byTrade)) {
    const counts = {};
    for (const r of rows) counts[bucket(r)] = (counts[bucket(r)] ?? 0) + 1;
    console.log(`\n  ${trade}: ${rows.length} assemblies — ${JSON.stringify(counts)}`);
    const broken = rows.filter((r) => bucket(r) === "NO PRICE BASIS");
    if (broken.length) {
      console.log(`  ✗ NO PRICE BASIS (can never auto-quote → routes to $99 inspection):`);
      for (const r of broken)
        console.log(`      - "${r.name}" price=${r.price} labour=${r.labour} enabled=${r.default_enabled}`);
    } else {
      console.log(`  ✓ every ${trade} assembly has a price or labour basis`);
    }
  }

  // ─── 3. shared_materials — unit price present ──────────────────────
  const smCols = await colsOf("shared_materials");
  const smSel = [
    "name",
    "trade",
    has(smCols, "category") ? "category" : "null as category",
    "default_unit_price_ex_gst as price",
  ].join(", ");
  const { rows: sm } = await client.query(
    `select ${smSel} from shared_materials order by trade, name`,
  );
  const smBad = sm.filter((r) => !pos(r.price));
  console.log("\n" + "=".repeat(72));
  console.log(`3. SHARED_MATERIALS — ${sm.length} rows, ${smBad.length} with no usable price`);
  console.log("=".repeat(72));
  if (smBad.length)
    for (const r of smBad)
      console.log(`  ✗ "${r.name}" (${r.trade}) price=${r.price}`);
  else console.log("  ✓ every shared material has a positive unit price");

  // ─── 4. tenant_custom_assemblies — price basis (enabled, auto-quote) ─
  const { rows: tcaTbl } = await client.query(
    `select count(*)::int n from information_schema.tables
      where table_schema='public' and table_name='tenant_custom_assemblies'`,
  );
  console.log("\n" + "=".repeat(72));
  console.log("4. TENANT_CUSTOM_ASSEMBLIES — tenant-owned services");
  console.log("=".repeat(72));
  if (!tcaTbl[0].n) {
    console.log("  (table absent)");
  } else {
    const tcaCols = await colsOf("tenant_custom_assemblies");
    const tcaSel = [
      "tca.name",
      "tca.trade",
      "tca.default_unit_price_ex_gst as price",
      "tca.default_labour_hours as labour",
      has(tcaCols, "enabled") ? "tca.enabled" : "true as enabled",
      has(tcaCols, "always_inspection") ? "tca.always_inspection" : "false as always_inspection",
      "t.business_name",
    ].join(", ");
    const { rows: tca } = await client.query(
      `select ${tcaSel} from tenant_custom_assemblies tca
         join tenants t on t.id = tca.tenant_id order by t.business_name, tca.name`,
    );
    console.log(`  ${tca.length} custom rows total`);
    const autoBroken = tca.filter(
      (r) => r.enabled && !r.always_inspection && !pos(r.price) && !pos(r.labour),
    );
    if (tca.length === 0) {
      console.log("  ✓ none defined (nothing to validate)");
    } else if (autoBroken.length === 0) {
      console.log("  ✓ every enabled auto-quote custom row has a price/labour basis");
    } else {
      console.log("  ✗ enabled, NOT always_inspection, but NO price basis:");
      for (const r of autoBroken)
        console.log(`      - [${r.business_name}] "${r.name}" price=${r.price} labour=${r.labour}`);
    }
  }

  // ─── 5. HEURISTIC: assemblies with no validator category ───────────
  // Mirrors lib/estimate/validate.ts categorise() as of this audit. A row
  // is COVERED if its name matches a regex below OR it carries an explicit
  // `category` (migration 029). An 'each'/'lm' line priced from a row that
  // is neither can still fail the SEMANTIC category check even when the
  // dollar amount is right. Informational.
  const catRe = [
    /\b(outdoor|exterior|deck|weatherproof|ip[-\s]?rated|garden|patio|wall\s*pack|flood\s*light|floodlight)\b/,
    /\bdownlight/,
    /\b(gpo|power\s*point|socket|wall\s*outlet|\busb\s*out)/,
    /\bsmoke\s*alarm|\binterconnect(?:ed)?\s+alarm|\b240v\s*alarm|\bhardwire[ds]?\b.*\balarm|\balarm\s+(?:install|replace|terminate|hardwire|kit)/,
    /\b(ceiling\s*fan|\bfan\b)/,
    /\b(rcbo|safety\s*switch|safety\s*breaker|circuit\s*breaker)\b/,
    /\b(oven|cooktop|stove|range\s*hood)\b/,
    /\b(ev\s*charger|electric\s*vehicle|wallbox)\b/,
    /\b(switchboard|switch\s*board|main\s*board|distribution\s*board)\b/,
    /\b(cctv|drain[-\s]?camera|camera\s*inspection)/,
    /\b(drain|blockage|blocked\s*pipe|jet[-\s]?blast(?:ing)?|hand[-\s]?rod(?:ding)?|jet[-\s]?clear)/,
    /\b(hot\s*water|\bhws\b|heat\s*pump|continuous[-\s]?flow|storage\s*tank|water\s*heater)/,
    /\b(tap[s]?\b|mixer|tap\s*washer|faucet|spout)/,
    /\b(toilet|cistern|close[-\s]?coupled|wall[-\s]?faced|in[-\s]?wall\s*cistern|flush\s*valve|fill\s*valve)/,
    /\b(gas\s*(?:appliance|leak|fitting|cooktop|oven|line|supply|pipe|connection)|gas[-\s]?bayonet|\blpg\b)\b/,
    /\b(pressure[-\s]?reduction\s*valve|\bprv\b|pressure\s*valve)/,
    // migration-021 extras (mirrors validate.ts as of migration 029)
    /\b(fault[-\s]?find(?:ing)?|diagnostic|diagnose)\b/,
    /\b(led\s*strip|strip\s*light(?:ing)?|cove\s*light(?:ing)?)\b/,
    /\b(security\s*camera|surveillance\s*camera|cctv\s*camera)\b/,
    /\b(doorbell|door\s*bell|intercom)\b/,
    /\bdish\s*washer\b/,
    /\b(rain\s*water\s*tank|rainwater\s*tank)\b/,
    /\b(water\s*filter|filtration|whole[-\s]?house\s*(?:water\s*)?filter)\b/,
    /\bleak\s*detect(?:ion|or)?\b/,
    /\b(shower\s*head|showerhead|shower\s*rose)\b/,
    /\b(sundries|sundry|terminals|consumables|miscellaneous|extras|disposal|removal\s*of\s*old|fittings\s*and\s*seals|pipe\s*tape|plumbing\s*sundries|teflon|ptfe)\b/,
  ];
  const noCat = sa.filter(
    (r) =>
      pos(r.price) &&
      !r.category &&
      !catRe.some((re) => re.test((r.name ?? "").toLowerCase())),
  );
  console.log("\n" + "=".repeat(72));
  console.log(`5. HEURISTIC — priced assemblies whose NAME maps to no validator`);
  console.log(`   category (an 'each' line off these can still fail the semantic`);
  console.log(`   grounding check). ${noCat.length} of ${sa.filter((r) => pos(r.price)).length} priced rows:`);
  console.log("=".repeat(72));
  for (const r of noCat) console.log(`  • "${r.name}" (${r.trade})`);
  if (!noCat.length) console.log("  ✓ every priced assembly name maps to a known category");
} catch (e) {
  console.error("AUDIT FAILED:", e.message ?? e);
  process.exit(1);
} finally {
  await client.end();
}

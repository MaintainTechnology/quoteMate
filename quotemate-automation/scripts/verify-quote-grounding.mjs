// ═══════════════════════════════════════════════════════════════════
// QuoteMate · quote grounding audit
//
// Usage:
//   node --env-file=.env.local scripts/verify-quote-grounding.mjs --token <share_token>
//
// Pulls a quote by share_token, walks every tier's line items, and
// verifies each unit_price_ex_gst against the live catalogue tables
// (shared_materials, shared_assemblies, pricing_books). For every line
// item we either:
//   ✓ MATCH — price (± $0.50) is derivable from a DB row, with or
//             without the standard markup
//   ✗ UNGROUNDED — no row in the catalogue produces this price
//
// Same logic the in-pipeline validator (lib/estimate/validate.ts) uses,
// so an audit run here mirrors what the production grounding gate sees.
// ═══════════════════════════════════════════════════════════════════

import pg from "pg";

const { Client } = pg;
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const token = getArg("--token");
if (!token) {
  console.error("Usage: node scripts/verify-quote-grounding.mjs --token <share_token>");
  process.exit(1);
}

const PRICE_TOL = 0.5;

const client = new Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

// ─── Pull the quote ──────────────────────────────────────────────────
const { rows: quoteRows } = await client.query(
  `select q.*, i.job_type, i.suburb, i.scope, i.caller, i.confidence, i.confidence_reason,
          i.inspection_required, i.risks
     from quotes q
     left join intakes i on i.id = q.intake_id
     where q.share_token = $1`,
  [token],
);
if (quoteRows.length === 0) {
  console.error(`No quote found with share_token=${token}`);
  await client.end();
  process.exit(1);
}
const q = quoteRows[0];

console.log("\n" + "═".repeat(72));
console.log(`QUOTE  share_token=${token}`);
console.log("═".repeat(72));
console.log(`quote_id:           ${q.id}`);
console.log(`intake_id:          ${q.intake_id}`);
console.log(`pricing_book_id:    ${q.pricing_book_id ?? "(null)"}`);
console.log(`job_type:           ${q.job_type}`);
console.log(`suburb:             ${q.suburb ?? "(null)"}`);
console.log(`needs_inspection:   ${q.needs_inspection}`);
console.log(`confidence:         ${q.confidence}`);
console.log(`scope_short:        ${q.scope_short ?? "(null)"}`);
if (q.scope_of_works) {
  console.log(`scope_of_works:     "${q.scope_of_works.slice(0, 120)}${q.scope_of_works.length > 120 ? "…" : ""}"`);
}

// ─── Pull the pricing book the quote was drafted against ─────────────
const { rows: pbRows } = await client.query(
  `select id, name, hourly_rate, apprentice_rate, call_out_minimum,
          default_markup_pct, min_labour_hours
     from pricing_books
     where id = $1`,
  [q.pricing_book_id],
);
const pb = pbRows[0] ?? null;

console.log("\n" + "─".repeat(72));
console.log("PRICING BOOK USED");
console.log("─".repeat(72));
if (!pb) {
  console.log("(no pricing book linked — or row was deleted)");
} else {
  console.log(`name:               ${pb.name}`);
  console.log(`hourly_rate:        $${pb.hourly_rate}`);
  console.log(`apprentice_rate:    $${pb.apprentice_rate}`);
  console.log(`call_out_minimum:   $${pb.call_out_minimum}`);
  console.log(`default_markup_pct: ${pb.default_markup_pct}%`);
  console.log(`min_labour_hours:   ${pb.min_labour_hours ?? "(default 2.0)"}`);
}

// ─── Catalogue: every shared_material + shared_assembly with their
//      raw + marked-up candidate prices (matching validator logic). ──
const [materials, assemblies] = await Promise.all([
  client.query(`select id, name, default_unit_price_ex_gst, properties from shared_materials`),
  client.query(`select id, name, default_unit_price_ex_gst, properties from shared_assemblies`),
]);

const markupPct = parseFloat(pb?.default_markup_pct ?? 28);
const hourlyRate = parseFloat(pb?.hourly_rate ?? 110);
const apprenticeRate = parseFloat(pb?.apprentice_rate ?? 55);

function withMarkup(p) {
  return Math.round(p * (1 + markupPct / 100) * 100) / 100;
}

// Build the candidate-price index — same as buildCandidatePrices() in
// lib/estimate/validate.ts.
function asCandidates(rows) {
  return rows.map((r) => ({
    name: r.name,
    raw: parseFloat(r.default_unit_price_ex_gst),
    marked: withMarkup(parseFloat(r.default_unit_price_ex_gst)),
    properties: r.properties,
  }));
}
const matCands = asCandidates(materials.rows);
const asmCands = asCandidates(assemblies.rows);

// Labour candidates — labour line items can match hourly_rate or
// apprentice_rate at any quantity, so we match on the unit price.
const labourCands = [
  { name: "hourly_rate (sparky)", raw: hourlyRate, marked: hourlyRate },
  { name: "apprentice_rate", raw: apprenticeRate, marked: apprenticeRate },
];

function matchPrice(unit, unitPrice) {
  const candidates = unit === "hr" ? labourCands : [...matCands, ...asmCands];
  for (const c of candidates) {
    if (Math.abs(c.raw - unitPrice) <= PRICE_TOL) {
      return { matched: c, basis: "raw" };
    }
    if (Math.abs(c.marked - unitPrice) <= PRICE_TOL) {
      return { matched: c, basis: `+${markupPct}% markup` };
    }
  }
  return null;
}

// ─── Per-tier line item audit ────────────────────────────────────────
const tiers = ["good", "better", "best"];
let overallGrounded = true;
let totalLineItems = 0;
let groundedItems = 0;

for (const t of tiers) {
  const tier = q[t];
  if (!tier) {
    console.log(`\n${t.toUpperCase()}: (null — not offered)`);
    continue;
  }

  console.log("\n" + "─".repeat(72));
  console.log(`TIER: ${t.toUpperCase()}    label="${tier.label ?? ""}"    subtotal_ex_gst=$${tier.subtotal_ex_gst}`);
  console.log("─".repeat(72));

  if (!Array.isArray(tier.line_items) || tier.line_items.length === 0) {
    console.log("  (no line items)");
    continue;
  }

  for (let i = 0; i < tier.line_items.length; i++) {
    const li = tier.line_items[i];
    totalLineItems++;
    const unitPrice = parseFloat(li.unit_price_ex_gst);
    const qty = parseFloat(li.quantity);
    const lineTotal = parseFloat(li.total_ex_gst);
    const expectedTotal = Math.round(unitPrice * qty * 100) / 100;

    const m = matchPrice(li.unit, unitPrice);
    if (m) {
      groundedItems++;
      console.log(
        `  #${i + 1}  ✓ MATCH  qty=${qty} ${li.unit} × $${unitPrice} = $${expectedTotal}\n` +
        `        line: "${li.description}"\n` +
        `        DB row: "${m.matched.name}" (${m.basis})`,
      );
    } else {
      overallGrounded = false;
      console.log(
        `  #${i + 1}  ✗ UNGROUNDED  qty=${qty} ${li.unit} × $${unitPrice} = $${expectedTotal}\n` +
        `        line: "${li.description}"\n` +
        `        no DB row in shared_materials, shared_assemblies, or pricing_book labour rates produces $${unitPrice} (raw or marked-up at ${markupPct}%)`,
      );
    }

    if (Math.abs(expectedTotal - lineTotal) > PRICE_TOL) {
      console.log(
        `      ⚠ arithmetic mismatch: line.total_ex_gst=$${lineTotal} but qty × unit_price = $${expectedTotal}`,
      );
    }
  }

  // Recompute subtotal from line items for sanity.
  const computedSubtotal = tier.line_items.reduce(
    (sum, li) => sum + parseFloat(li.total_ex_gst), 0,
  );
  const recordedSubtotal = parseFloat(tier.subtotal_ex_gst);
  if (Math.abs(computedSubtotal - recordedSubtotal) > PRICE_TOL) {
    console.log(
      `\n  ⚠ subtotal mismatch: stored=$${recordedSubtotal.toFixed(2)} but sum of line_items=$${computedSubtotal.toFixed(2)}`,
    );
  }
  const incGst = Math.round(recordedSubtotal * 1.1);
  console.log(`\n  computed inc-GST (×1.10) = $${incGst}    (this is what the customer SMS shows)`);
}

// ─── Summary ─────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(72));
console.log("AUDIT SUMMARY");
console.log("═".repeat(72));
console.log(`line items checked:   ${totalLineItems}`);
console.log(`grounded in catalogue: ${groundedItems}`);
console.log(`ungrounded:           ${totalLineItems - groundedItems}`);
console.log(`verdict:              ${overallGrounded ? "✓ ALL PRICES GROUNDED IN CATALOGUE" : "✗ SOME LINE ITEMS WERE NOT FOUND IN THE CATALOGUE — possible hallucination"}`);

// ─── Catalogue dump for the relevant job_type so user can sanity-check
//      the prices themselves ──────────────────────────────────────────
const jobKeyword = (q.job_type ?? "").replace(/_/g, " ");
console.log("\n" + "─".repeat(72));
console.log(`RELEVANT CATALOGUE ROWS  (matching "${jobKeyword}" or "fan")`);
console.log("─".repeat(72));

const matchPattern = `%${jobKeyword.split(" ")[0]}%`;
const { rows: relevantMats } = await client.query(
  `select 'material' as kind, name, default_unit_price_ex_gst, properties
     from shared_materials
     where name ilike $1 or name ilike '%fan%'
   union all
   select 'assembly' as kind, name, default_unit_price_ex_gst, properties
     from shared_assemblies
     where name ilike $1 or name ilike '%fan%'
   order by kind, default_unit_price_ex_gst`,
  [matchPattern],
);
if (relevantMats.length === 0) {
  console.log("(no rows match — broader keyword may be needed)");
} else {
  for (const r of relevantMats) {
    const raw = parseFloat(r.default_unit_price_ex_gst);
    const marked = withMarkup(raw);
    const props = r.properties ? JSON.stringify(r.properties).slice(0, 60) : "";
    console.log(
      `  ${r.kind.padEnd(8)}  $${raw.toFixed(2).padStart(7)} (raw)  →  $${marked.toFixed(2).padStart(7)} (+${markupPct}% markup)  "${r.name}"${props ? "  " + props : ""}`,
    );
  }
}

await client.end();

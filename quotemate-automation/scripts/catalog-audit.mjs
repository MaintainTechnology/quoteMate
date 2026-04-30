// ═══════════════════════════════════════════════════════════════════
// QuoteMate · Catalog audit
//
// Queries Supabase (via service-role key) to show what services and
// pricing are actually available in the DB, then maps each item to
// the AI receptionist's system prompt + the Estimator's tool surface.
//
// Goal: prove the quote pipeline pulls only from real DB rows, and
// surface any gaps where the AI knows about a job type the DB has no
// pricing for.
// ═══════════════════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const dollar = (n) => `$${Number(n).toFixed(2).padStart(8)}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

// ─── 1. Pricing book ────────────────────────────────────────────────
console.log(bold("\n══ PRICING BOOK (the tradie's defaults) ════════════════════════════"));
const { data: pb } = await supabase.from("pricing_book").select("*").single();
if (!pb) {
  console.log(red("  ✗ No pricing_book row — Stage 05 will fail."));
} else {
  console.log(`  hourly_rate          ${dollar(pb.hourly_rate)} / hr`);
  console.log(`  call_out_minimum     ${dollar(pb.call_out_minimum)}`);
  console.log(`  apprentice_rate      ${dollar(pb.apprentice_rate)} / hr`);
  console.log(`  default_markup_pct   ${pb.default_markup_pct}%   (applied to materials)`);
  console.log(`  risk_buffer_pct      ${pb.risk_buffer_pct}%   (applied to subtotal when access is hard)`);
  console.log(`  gst_registered       ${pb.gst_registered}`);
  console.log(`  licence              ${pb.licence_type ?? "(unset)"} ${pb.licence_state ?? ""} ${pb.licence_number ?? ""}`);
}

// ─── 2. Assemblies ──────────────────────────────────────────────────
console.log(bold("\n══ SHARED_ASSEMBLIES (the work units the Estimator quotes from) ══"));
const { data: assemblies } = await supabase
  .from("shared_assemblies")
  .select("*")
  .order("name");
console.log(dim(`  ${"name".padEnd(45)} ${"unit_price".padStart(10)} ${"labour_hrs".padStart(11)} → labour cost`));
console.log(dim("  " + "─".repeat(85)));
for (const a of assemblies ?? []) {
  const labourCost = Number(a.default_labour_hours) * Number(pb?.hourly_rate ?? 0);
  console.log(
    `  ${(a.name ?? "").padEnd(45)} ${dollar(a.default_unit_price_ex_gst)} ${(a.default_labour_hours + " hrs").padStart(11)} → ${dollar(labourCost)}`
  );
}

// ─── 3. Materials ───────────────────────────────────────────────────
console.log(bold("\n══ SHARED_MATERIALS (the products the Estimator can substitute) ══"));
const { data: materials } = await supabase
  .from("shared_materials")
  .select("*")
  .order("default_unit_price_ex_gst");
console.log(dim(`  ${"name".padEnd(45)} ${"brand".padEnd(10)} ${"unit_price".padStart(10)}`));
console.log(dim("  " + "─".repeat(75)));
for (const m of materials ?? []) {
  const markedUp = Number(m.default_unit_price_ex_gst) * (1 + Number(pb?.default_markup_pct ?? 0) / 100);
  console.log(
    `  ${(m.name ?? "").padEnd(45)} ${(m.brand ?? "—").padEnd(10)} ${dollar(m.default_unit_price_ex_gst)}  → ${dollar(markedUp)} after ${pb?.default_markup_pct}% markup`
  );
}

// ─── 4. Job-type coverage ───────────────────────────────────────────
console.log(bold("\n══ JOB-TYPE COVERAGE (assistant prompt enum vs real DB rows) ══"));
const promptJobTypes = [
  { id: "downlights", expected: "auto-quote", searchTerms: ["downlight", "led"] },
  { id: "power_points", expected: "auto-quote", searchTerms: ["GPO", "power point", "double GPO"] },
  { id: "ceiling_fans", expected: "auto-quote", searchTerms: ["ceiling fan", "fan"] },
  { id: "smoke_alarms", expected: "auto-quote", searchTerms: ["smoke alarm", "smoke"] },
  { id: "outdoor_lighting", expected: "auto-quote", searchTerms: ["outdoor", "IP-rated", "deck"] },
  { id: "switchboard", expected: "inspection-only", searchTerms: ["switchboard"] },
  { id: "oven_cooktop", expected: "case-by-case", searchTerms: ["oven", "cooktop"] },
  { id: "ev_charger", expected: "inspection-only", searchTerms: ["EV", "charger"] },
  { id: "fault_finding", expected: "diagnostic", searchTerms: ["fault", "diagnostic"] },
  { id: "renovation", expected: "inspection-only", searchTerms: ["renovation", "renov"] },
  { id: "other", expected: "fallback", searchTerms: [] },
];

console.log(dim(`  ${"job_type".padEnd(20)} ${"v1 routing".padEnd(18)} ${"asm match?".padEnd(12)} ${"mat match?".padEnd(12)} verdict`));
console.log(dim("  " + "─".repeat(90)));

let issues = [];
for (const jt of promptJobTypes) {
  const asmHit = (assemblies ?? []).find((a) =>
    jt.searchTerms.some((t) => a.name.toLowerCase().includes(t.toLowerCase()))
  );
  const matHit = (materials ?? []).find((m) =>
    jt.searchTerms.some((t) => (m.name ?? "").toLowerCase().includes(t.toLowerCase()))
  );

  let verdict;
  let mark;
  if (jt.expected === "auto-quote") {
    if (asmHit) {
      verdict = green("DB row → Opus can quote this");
      mark = "✓";
    } else {
      verdict = red("MISSING — Opus will fail or guess");
      mark = "✗";
      issues.push(`Auto-quote job '${jt.id}' has no shared_assemblies row`);
    }
  } else if (jt.expected === "inspection-only") {
    if (asmHit) {
      verdict = yellow("has DB row but routed to inspection — OK if for fallback");
      mark = "○";
    } else {
      verdict = green("inspection fallback only — no DB row needed");
      mark = "✓";
    }
  } else if (jt.expected === "case-by-case") {
    if (asmHit) {
      verdict = green("DB row → Opus can quote when wiring is confirmed");
      mark = "✓";
    } else {
      verdict = yellow("no DB row — will route to inspection by default");
      mark = "○";
      issues.push(`Case-by-case job '${jt.id}' has no shared_assemblies row — defaults to inspection`);
    }
  } else if (jt.expected === "diagnostic") {
    verdict = green("call-out + hourly rate — no assembly needed");
    mark = "✓";
  } else {
    verdict = green("fallback — no DB row needed");
    mark = "✓";
  }

  console.log(
    `  ${jt.id.padEnd(20)} ${jt.expected.padEnd(18)} ${(asmHit ? `✓ ${asmHit.name.slice(0, 8)}` : "—").padEnd(12)} ${(matHit ? `✓ ${matHit.name.slice(0, 8)}` : "—").padEnd(12)} ${mark} ${verdict}`
  );
}

// ─── 5. Tier coverage check (downlights) ────────────────────────────
console.log(bold("\n══ TIER COVERAGE (downlights — the most common job) ════════════"));
const downlightMaterials = (materials ?? []).filter((m) =>
  (m.name ?? "").toLowerCase().includes("downlight")
);
console.log(`  Found ${downlightMaterials.length} downlight materials:`);
for (const dl of downlightMaterials) {
  console.log(`    · ${dl.name.padEnd(38)} ${dollar(dl.default_unit_price_ex_gst)}`);
}
const tierLabels = ["Good (basic)", "Better (tri-colour)", "Best (dimmable IP)"];
if (downlightMaterials.length >= 3) {
  console.log(`  ${green("✓")} 3 tiers cleanly mappable: ${tierLabels.join(", ")}`);
} else {
  console.log(
    `  ${yellow("⚠")} Only ${downlightMaterials.length} downlight materials — Opus may have to repeat materials across tiers.`
  );
  issues.push("Downlight catalog has <3 tiers — quotes may have repeated tiers");
}

// ─── 6. GPO tier check ──────────────────────────────────────────────
const gpoMaterials = (materials ?? []).filter(
  (m) => (m.name ?? "").toLowerCase().includes("gpo")
);
console.log(`\n  GPO materials: ${gpoMaterials.length}`);
for (const g of gpoMaterials) {
  console.log(`    · ${g.name.padEnd(38)} ${(g.brand ?? "").padEnd(10)} ${dollar(g.default_unit_price_ex_gst)}`);
}
if (gpoMaterials.length < 3) {
  issues.push("GPO catalog has <3 tiers — Opus has only 'standard' and 'USB' to choose from for Better/Best");
}

// ─── 7. Summary ─────────────────────────────────────────────────────
console.log(bold("\n══ ALIGNMENT VERDICT ════════════════════════════════════════════"));
if (issues.length === 0) {
  console.log(green("  ✓ Pipeline is fully aligned with DB."));
} else {
  console.log(yellow(`  ⚠ ${issues.length} alignment notes:`));
  for (const i of issues) console.log(yellow(`    · ${i}`));
}
console.log("");

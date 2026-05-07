// ═══════════════════════════════════════════════════════════════════
// QuoteMate · Update Vapi transcriber — Deepgram Nova-3 + en-AU +
// keyword boost list + endpointing tuned for natural turn-taking.
//
// Why: testers reported voice as "flakey and inconsistent" after the
// new Vapi account migration. New accounts default to nova-2 with
// generic English and no keyword boosts — which means trade jargon
// ("downlights", "GPO", "RCD"), Aussie place names, and acronyms get
// mis-transcribed, which then makes Jon ask follow-up questions or
// produce garbled scope. Nova-3 + en-AU + boosted trade keywords
// fixes the bulk of "flakey" complaints.
//
// Usage:  node --env-file=.env.local scripts/update-vapi-transcriber.mjs
//
// Env required:  VAPI_API_KEY  +  VAPI_ASSISTANT_ID
//
// Idempotent — re-running just confirms the current config matches.
// ═══════════════════════════════════════════════════════════════════

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

if (!VAPI_API_KEY || !VAPI_ASSISTANT_ID) {
  console.error("Missing VAPI_API_KEY or VAPI_ASSISTANT_ID in .env.local");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${VAPI_API_KEY}`,
  "Content-Type": "application/json",
};

async function vapi(method, path, body) {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// Boost weights: 1 = mild, 2 = strong, 3 = very strong.
// Boost only words Deepgram has a weak prior on — trade jargon, acronyms,
// proper nouns, brand names. Don't boost common English (it hurts more
// than it helps).
//
// IMPORTANT: Vapi's `keywords` field requires SINGLE TOKENS only — multi-word
// entries like "power point" or "Surry Hills" are rejected with HTTP 400.
// For compound trade terms ("ceiling fan", "smoke alarm"), Deepgram's en-AU
// model handles them well unboosted because both component words are common.
// We only need to boost the irregular jargon, acronyms, and proper nouns.
const KEYWORDS = [
  // ── Electrical fittings — single-token jargon ──
  "downlight:2", "downlights:2",
  "GPO:3", "GPOs:3",
  "switchboard:2",
  "bollard:1",

  // ── Inspection-only triggers (single tokens) ──
  "fault:1",

  // ── Job-specific items ──
  "oven:1", "cooktop:1", "rangehood:1",

  // ── Acronyms — heavily boosted (Deepgram default = poor) ──
  // Vapi rejects mixed alphanumerics like "IP65" — drop it; Deepgram's
  // smartFormat handles "IP" + number combos at transcription time anyway.
  "RCD:3", "MCB:3", "RCBO:3", "LED:2", "LEDs:2",

  // ── Spec descriptors (alphabetic single tokens only) ──
  // Vapi rejects hyphenated tokens — "tri-colour" can't be boosted, but
  // Deepgram en-AU handles the compound reliably without help.
  "dimmable:2", "dimmer:1", "halogen:1",
  "weatherproof:1",

  // ── Brand + persona ──
  "QuoteMate:3", "Jon:2",
  "Clipsal:1", "HPM:1", "NEC:1",

  // ── Sydney suburbs (single-token only) ──
  "Bondi:1", "Paddington:1", "Coogee:1", "Redfern:1",
  "Newtown:1", "Marrickville:1", "Manly:1", "Glebe:1",
  "Erskineville:1", "Chatswood:1", "Randwick:1",

  // ── Aussie acknowledgements ──
  "sparky:1", "sparkies:1",
];

const TARGET = {
  provider: "deepgram",
  model: "nova-3",
  language: "en-AU",
  keywords: KEYWORDS,
  smartFormat: true,
  // ms of silence before Deepgram considers a turn finished.
  // 300ms feels natural; <200 causes Jon to interrupt; >500 causes
  // long awkward pauses between turns.
  endpointing: 300,
};

// ─── 1. Fetch current ───────────────────────────────────────────────
console.log(`\n[1/3] Fetching assistant ${VAPI_ASSISTANT_ID}...`);
const before = await vapi("GET", `/assistant/${VAPI_ASSISTANT_ID}`);
if (!before.ok) {
  console.error(`✗ Could not fetch assistant: HTTP ${before.status}`);
  console.error(typeof before.data === "string" ? before.data : JSON.stringify(before.data, null, 2));
  process.exit(1);
}

const cur = before.data.transcriber ?? {};
console.log(`      Current transcriber:`);
console.log(`        provider:    ${cur.provider ?? "(unset)"}`);
console.log(`        model:       ${cur.model ?? "(unset)"}`);
console.log(`        language:    ${cur.language ?? "(unset)"}`);
console.log(`        keywords:    ${(cur.keywords?.length ?? 0)} entries`);
console.log(`        endpointing: ${cur.endpointing ?? "(default)"}`);
console.log(`        smartFormat: ${cur.smartFormat ?? false}`);

// ─── 2. PATCH ──────────────────────────────────────────────────────
console.log(`\n[2/3] PATCHing transcriber → ${TARGET.provider} / ${TARGET.model} / ${TARGET.language}`);
console.log(`      Keywords:    ${KEYWORDS.length} entries (electrical fittings, acronyms, spec terms, AU suburbs)`);
console.log(`      Endpointing: ${TARGET.endpointing} ms`);
console.log(`      smartFormat: on`);

const patch = await vapi("PATCH", `/assistant/${VAPI_ASSISTANT_ID}`, { transcriber: TARGET });
if (!patch.ok) {
  console.error(`\n✗ PATCH failed: HTTP ${patch.status}`);
  console.error(typeof patch.data === "string" ? patch.data : JSON.stringify(patch.data, null, 2));
  process.exit(1);
}

// ─── 3. Verify ─────────────────────────────────────────────────────
console.log(`\n[3/3] Verifying...`);
const after = await vapi("GET", `/assistant/${VAPI_ASSISTANT_ID}`);
const t = after.data.transcriber ?? {};

const checks = [
  ["provider = deepgram",        t.provider === "deepgram"],
  ["model = nova-3",              t.model === "nova-3"],
  ["language = en-AU",            t.language === "en-AU"],
  [`keywords (${KEYWORDS.length})`, (t.keywords?.length ?? 0) === KEYWORDS.length],
  ["smartFormat = true",          t.smartFormat === true],
  ["endpointing = 300",           t.endpointing === 300],
];

let allOk = true;
for (const [name, ok] of checks) {
  console.log(`      ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) allOk = false;
}

if (!allOk) {
  console.warn(`\n⚠ Some fields didn't apply. Vapi may have silently rejected unknown keys for the new account.`);
  console.warn(`   Full transcriber state:\n${JSON.stringify(t, null, 2)}`);
  process.exitCode = 1;
}

console.log(`\n✓ Transcriber updated.`);
console.log(`\nNext — dial the Vapi number and test these phrases:`);
console.log(`  · "Six dimmable warm-white downlights in the lounge"`);
console.log(`     → expect: "downlights" (not "downloads"), "dimmable" (not "dim able"), "warm white" intact`);
console.log(`  · "Four GPOs in the garage, single-phase"`);
console.log(`     → expect: "GPOs" (not "G P O's" or "Jeepos"), "single-phase" intact`);
console.log(`  · "There's a fault in the switchboard"`);
console.log(`     → expect: escalates to inspection (transcriber must capture "switchboard" + "fault")`);
console.log(`  · "I'm in Bondi 2026, this Saturday"`);
console.log(`     → expect: "Bondi" + "2026" intact, no homophone confusion\n`);

// Updates the Vapi assistant's system prompt to streamline confirmation
// readbacks: drop name + suburb readbacks (no pricing impact) and keep
// only the SCOPE+SPECS combined readback (the one Deepgram errors on
// would actually cost money).
//
// Why: per-field readbacks for name, suburb, job_type, and scope_preference
// felt robotic and slowed the call. Real receptionists don't say "Just to
// confirm — that's Sam?". Real receptionists do read scope back though,
// because "16 downlights" mistranscribed as "6" is a real money mistake.
//
// Net effect: 4 readbacks → 1 readback. Pricing accuracy preserved.
//
// Idempotent — re-running detects the streamlined block is already in
// place and exits without modifying.
//
// Usage: node --env-file=.env.local scripts/update-vapi-streamline-readbacks.mjs

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

if (!VAPI_API_KEY || !VAPI_ASSISTANT_ID) {
  console.error("Missing VAPI_API_KEY or VAPI_ASSISTANT_ID in env");
  process.exit(1);
}

// ─── Old block: full CONFIRMATION PROTOCOL section (4 readbacks) ──
const OLD_CONFIRMATION = `CONFIRMATION PROTOCOL — read back each critical field ONCE
After capturing each critical field below, briefly read the value back and
confirm in a SINGLE short check (max ~8 words). Do this exactly ONCE per
field — never re-confirm an already-corrected answer.

  caller.name      → "Just to confirm — that's [name]?"
  suburb           → "Got it, [suburb] — is that right?"
  job_type + count → "So that's [N] [job_type] in your [room/area],
                      [replacing existing / new install] — correct?"
  scope preference → "And [tri-colour LED / weatherproof / interconnected
                      smoke alarms etc.] — that's what you wanted?"
  preferred_date   → "Okay, [date/timeframe] works for you?" (only if given)
  emergency        → if any emergency keyword fires:
                      "Just to be sure — there's [smell/sparks/shock]
                      happening right now?" (one short check, then
                      EMERGENCY OVERRIDE)

DO confirm: name · suburb · job_type-with-count · scope preferences ·
            urgent timing
DO NOT confirm: caller phone (caller ID has it · never ask, never read
            back) · sub-detail questions like ceiling type or wall type
            (just ask, capture, move on — readbacks here would drag the
            call out without adding accuracy)

If the caller corrects you, repeat the corrected value back ONCE in
acknowledgement ("ah, [corrected value], got it") and move forward. Do
not loop on a third confirmation.`;

// ─── New block: streamlined to ONE combined readback ──────────────
const NEW_CONFIRMATION = `CONFIRMATION PROTOCOL — ONE high-value readback only
You DO NOT read back name, suburb, ceiling type, wall type, or any other
field that doesn't change the quote price. Capture them silently and move
on. Real receptionists don't say "Just to confirm — that's Sam?" — and
neither should you. It feels robotic and adds friction without adding
accuracy.

ONE READBACK is mandatory: the SCOPE-and-SPECS combined readback. This is
the only field where a Deepgram mistranscription actually loses money
(hearing "16" as "6" is a $2,000+ quote difference). Do it ONCE, after
the customer has finished describing BOTH the work AND any spec
preferences they care about (warm-white, dimmable, weatherproof, etc.).

Combined scope+specs readback shape:
  "So that's [N] [job_type] in your [room/area], [replacing existing /
   new install], [warm-white / dimmable / weatherproof / etc.] — that all
   sound right?"

EMERGENCY EXCEPTION: when any emergency keyword fires (burning smell,
sparks, smoke, shock, no power, water+electrical), do ONE quick safety
confirmation — "Just to be sure — there's [smell/sparks/shock] happening
right now?" — before invoking EMERGENCY OVERRIDE. Safety verification is
the single exception to the no-extra-readbacks rule.

If the caller corrects you on the scope readback, repeat the corrected
value back ONCE in acknowledgement ("ah, [corrected value], got it") and
move forward. Do not loop on a third confirmation.`;

// ─── Old OPENING block ────────────────────────────────────────────
const OLD_OPENING = `OPENING
The firstMessage already asked for the name. As soon as the caller
answers, run the opening sequence:
  1. Confirm the name back (per CONFIRMATION PROTOCOL)
  2. "And what suburb are you in?" → confirm
  3. "What can we help you with today?" → classify job_type
  4. Confirm the scope summary back once classified
       e.g. "So that's six downlights in your kitchen, replacing existing
       halogens — is that right?"

DO NOT ask for or read back the mobile — caller ID already has it.
DO NOT ask the same question twice once they've answered and confirmed.`;

const NEW_OPENING = `OPENING
The firstMessage already asked for the name. As soon as the caller
answers, run the opening sequence:
  1. Capture the name silently — DO NOT read it back.
  2. "And what suburb are you in?" — capture silently, DO NOT read back.
  3. "What can we help you with today?" → classify job_type
  4. Walk through the job-type-specific question tree (AUTO-QUOTE 5 or
     INSPECTION-ONLY)
  5. AT THE END (once scope + spec questions are all answered): do the
     ONE combined readback per CONFIRMATION PROTOCOL —
       e.g. "So that's six downlights in your kitchen, replacing existing
       halogens, warm-white — that all sound right?"

DO NOT ask for or read back the mobile — caller ID already has it.
DO NOT read back the name. DO NOT read back the suburb.
DO NOT ask the same question twice once they've answered.`;

// ─── Fetch current assistant ──────────────────────────────────────
console.log(`→ Fetching assistant ${VAPI_ASSISTANT_ID}`);
const fetchRes = await fetch(`https://api.vapi.ai/assistant/${VAPI_ASSISTANT_ID}`, {
  headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
});
if (!fetchRes.ok) {
  console.error(`✗ Failed to fetch assistant: HTTP ${fetchRes.status}`);
  console.error(await fetchRes.text());
  process.exit(1);
}
const existing = await fetchRes.json();
const messages = existing.model?.messages ?? [];
const sysMsg = messages.find((m) => m.role === "system");
if (!sysMsg) {
  console.error("✗ No system message found in assistant config");
  process.exit(1);
}

const before = sysMsg.content;
console.log(`  System prompt length: ${before.length} chars`);

// ─── Idempotency check ───────────────────────────────────────────
if (before.includes("CONFIRMATION PROTOCOL — ONE high-value readback only")) {
  console.log("✓ Streamlined readback block already in place — nothing to do");
  process.exit(0);
}

// ─── Apply replacements ──────────────────────────────────────────
const replacements = [
  ["CONFIRMATION PROTOCOL", OLD_CONFIRMATION, NEW_CONFIRMATION],
  ["OPENING", OLD_OPENING, NEW_OPENING],
];

let after = before;
for (const [label, oldText, newText] of replacements) {
  if (!after.includes(oldText)) {
    console.error(`✗ Could not find expected ${label} block in current prompt.`);
    console.error(`  The prompt may have drifted from the version this script targets.`);
    console.error(`  Refusing to PATCH — manual update required.`);
    process.exit(1);
  }
  after = after.replace(oldText, newText);
}

const sizeDelta = after.length - before.length;
console.log(`\n→ Replacements applied`);
console.log(`  Before: ${before.length} chars`);
console.log(`  After:  ${after.length} chars  (${sizeDelta >= 0 ? "+" : ""}${sizeDelta})`);

// ─── PATCH the assistant ─────────────────────────────────────────
const updatedMessages = messages
  .filter((m) => m.role !== "system")
  .concat([{ role: "system", content: after }]);

const updatedModel = { ...existing.model, messages: updatedMessages };

console.log(`\n→ PATCHing assistant model.messages`);
const patchRes = await fetch(`https://api.vapi.ai/assistant/${VAPI_ASSISTANT_ID}`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${VAPI_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ model: updatedModel }),
});

const text = await patchRes.text();
let parsed;
try { parsed = JSON.parse(text); } catch { parsed = text; }

if (!patchRes.ok) {
  console.error(`\n✗ PATCH failed: HTTP ${patchRes.status}`);
  console.error(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2));
  process.exit(1);
}

console.log(`\n✓ Assistant updated`);
console.log(`  System prompt now: ${parsed.model?.messages?.find((m) => m.role === "system")?.content?.length ?? 0} chars`);
console.log(`\nWhat to test on the next call:`);
console.log(`  - Jon should NOT say "Just to confirm — that's [name]?" anymore`);
console.log(`  - Jon should NOT say "Got it, [suburb] — is that right?" anymore`);
console.log(`  - Jon SHOULD do ONE combined readback at the end:`);
console.log(`    "So that's 6 downlights in your kitchen, replacing existing`);
console.log(`     halogens, warm-white — that all sound right?"`);

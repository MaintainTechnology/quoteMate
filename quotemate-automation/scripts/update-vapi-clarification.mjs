// ═══════════════════════════════════════════════════════════════════
// QuoteMate · Add a CLARIFICATION PROTOCOL for unclear answers
//
// The existing CONFIRMATION PROTOCOL handles "read back what you heard
// once". This adds the complementary rule for "if the answer was unclear
// in the first place, re-ask up to twice, especially for job type and
// scope".
//
// Confirmation  = "I heard X — correct?"   (fires after a clean answer)
// Clarification = "Sorry, was that X or Y?" (fires BEFORE you have one)
//
// Inserted right after the CONFIRMATION PROTOCOL block.
// Idempotent — re-running is safe.
// ═══════════════════════════════════════════════════════════════════

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;
if (!VAPI_API_KEY || !VAPI_ASSISTANT_ID) {
  console.error("Missing VAPI_API_KEY or VAPI_ASSISTANT_ID");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${VAPI_API_KEY}`,
  "Content-Type": "application/json",
};

async function vapi(method, path, body) {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

console.log(`\n[1/3] Fetching assistant...`);
const before = await vapi("GET", `/assistant/${VAPI_ASSISTANT_ID}`);
if (!before.ok) { console.error(`HTTP ${before.status}`); process.exit(1); }
const a = before.data;
let sys = a.model?.messages?.find((m) => m.role === "system")?.content ?? "";
const originalLen = sys.length;
console.log(`      Prompt: ${originalLen} chars`);

// Anchor: the closing line of the existing CONFIRMATION PROTOCOL.
const anchor = `If the caller corrects you, repeat the corrected value back ONCE in
acknowledgement ("ah, [corrected value], got it") and move forward. Do
not loop on a third confirmation.`;

const clarificationBlock = `

CLARIFICATION PROTOCOL — when an answer is unclear in the first place
Confirmation reads back what you heard once you've heard it. Clarification
fixes what you didn't hear clearly. If the customer's answer is fuzzy,
partial, mumbled, or could mean two different things, ask a follow-up.
Up to TWO clarifying re-asks per question is fine — clarification is
separate from confirmation, so it doesn't conflict with the "one
confirmation per field" rule.

Be especially careful with:
  · JOB TYPE — if they say "lights", "fan", "powerpoints", "wiring",
    drill in: "Sure — by lights, do you mean downlights in the ceiling,
    or outdoor / deck lighting?" Never classify on a guess.
  · SCOPE / WHAT THEY WANT DONE — if it's vague ("I just need an
    electrician", "fix the issue"), keep asking until you have a concrete
    unit of work: a count, a room/area, and replace-vs-new.
  · NUMBERS that sound alike (four/fourteen, two/twelve, fifteen/fifty) —
    "Sorry mate, did you say four or fourteen?"
  · SUBURB names not clean in the transcript — "Could you say the suburb
    again for me?"
  · Mumbled or garbled stretches — one polite re-ask is fine: "Sorry, I
    missed that last bit — could you say it again?"

If after TWO clarifying re-asks the answer is still unclear:
  · Note it in scope.description as "[unclear: <what they said>]"
  · Move on rather than stalling the call
  · Lower confidence to MEDIUM or LOW depending on what's missing

Order of operations: CLARIFY (until you have a clean answer) → CONFIRM
(read it back once) → next question. Don't confirm something you weren't
sure you heard right — clarify first.`;

console.log(`\n[2/3] Inserting CLARIFICATION PROTOCOL after CONFIRMATION block...`);

if (sys.includes("CLARIFICATION PROTOCOL")) {
  console.log(`      = already present — skipping`);
} else if (!sys.includes(anchor)) {
  console.error(`      ✗ anchor not found in current prompt`);
  console.error(`        (the CONFIRMATION PROTOCOL block must be present`);
  console.error(`         and end with the "Do not loop on a third confirmation." line)`);
  process.exit(1);
} else {
  sys = sys.replace(anchor, anchor + clarificationBlock);
  console.log(`      ✓ inserted (${sys.length - originalLen} chars added)`);
}

const payload = {
  model: {
    ...a.model,
    messages: [
      { role: "system", content: sys },
      ...((a.model?.messages ?? []).filter((m) => m.role !== "system")),
    ],
  },
};

const patch = await vapi("PATCH", `/assistant/${VAPI_ASSISTANT_ID}`, payload);
if (!patch.ok) {
  console.error(`✗ PATCH failed: HTTP ${patch.status}`);
  console.error(typeof patch.data === "string" ? patch.data : JSON.stringify(patch.data, null, 2));
  process.exit(1);
}

console.log(`\n[3/3] Verifying...`);
const after = await vapi("GET", `/assistant/${VAPI_ASSISTANT_ID}`);
const v = after.data.model?.messages?.find((m) => m.role === "system")?.content ?? "";
const checks = [
  ["CLARIFICATION PROTOCOL block",        v.includes("CLARIFICATION PROTOCOL")],
  ["job-type clarify rule",               v.includes("by lights, do you mean")],
  ["two-tries fallback",                  v.includes("after TWO clarifying re-asks")],
  ["four/fourteen number example",        v.includes("four or fourteen")],
  ["clarify-before-confirm ordering",     v.includes("CLARIFY (until you have a clean answer) → CONFIRM")],
  ["existing CONFIRMATION block intact",  v.includes("CONFIRMATION PROTOCOL")],
  ["Jeff identity intact",                v.includes("You are Jeff")],
];

for (const [name, ok] of checks) {
  console.log(`      ${ok ? "✓" : "✗"} ${name}`);
}

console.log(`\n✓ Jeff now CLARIFIES unclear answers (up to 2 re-asks) before CONFIRMING.`);
console.log(`  Prompt: ${originalLen} → ${v.length} chars\n`);

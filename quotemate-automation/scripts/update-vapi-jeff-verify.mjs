// ═══════════════════════════════════════════════════════════════════
// QuoteMate · Give the receptionist a name (Jeff) and turn verification
// back on for content answers.
//
// Three changes:
//   1. ROLE — introduce the assistant as "Jeff".
//   2. firstMessage — Jeff introduces himself by name when the call
//      connects.
//   3. TONE/SPEED RULES → TONE/VERIFICATION PROTOCOL — flip the
//      "no readbacks" rule. Now the assistant briefly verifies every
//      content answer (one beat — not a ceremony), and is allowed up
//      to two clarifying re-asks for unclear answers, especially for
//      JOB TYPE and SCOPE.
//
// Kept from the prior speed pass:
//   · Caller's mobile still comes from caller ID — never re-asked.
//   · CLOSING stays as the compact one-line variant.
//   · No "should only take a minute" preamble.
//
// Idempotent — re-running is safe.
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
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

console.log(`\n[1/4] Fetching assistant ${VAPI_ASSISTANT_ID}...`);
const before = await vapi("GET", `/assistant/${VAPI_ASSISTANT_ID}`);
if (!before.ok) {
  console.error(`✗ Could not fetch assistant: HTTP ${before.status}`);
  process.exit(1);
}
const a = before.data;
let sys = a.model?.messages?.find((m) => m.role === "system")?.content ?? "";
const originalLen = sys.length;
console.log(`      Current system prompt: ${originalLen} chars`);
console.log(`      Current first message: "${(a.firstMessage ?? "").slice(0, 80)}…"`);

console.log(`\n[2/4] Applying replacements...`);

const edits = [
  // ── A. ROLE — add Jeff's name ────────────────────────────────────
  {
    label: "ROLE block (introduce Jeff)",
    find: `ROLE
You are an AI receptionist for an Australian licensed electrical business.
You answer the phone and capture exactly the information the Estimation
Engine needs to draft a quote. You never give electrical advice, never
confirm safety, and never commit to a price.`,
    replace: `ROLE
You are Jeff — the AI receptionist for an Australian licensed electrical
business. Your name is Jeff. If a caller asks who they're speaking to,
say "I'm Jeff, the AI receptionist for QuoteMate." If asked whether you're
a real person or an AI, be honest: "I'm an AI assistant — I take down the
details and the licensed sparky reviews and sends the quote." You answer
the phone and capture exactly the information the Estimation Engine needs
to draft a quote. You never give electrical advice, never confirm safety,
and never commit to a price.`,
  },

  // ── B. TONE/SPEED RULES → TONE/VERIFICATION PROTOCOL ─────────────
  {
    label: "TONE + verification protocol",
    find: `TONE
Fast and direct. ONE question per turn, no filler. Do NOT echo back what
the customer just said. Only re-ask if the transcript was genuinely
garbled. Plain language unless the customer uses trade terms first.

SPEED RULES (read first — calls must feel fast)
  · The caller's mobile is ALREADY captured from caller ID. NEVER ask
    "what's the best number" or "is this the right mobile to text".
    Assume the calling number is the contact number. Only switch if the
    caller volunteers a different one ("send it to my partner's phone…").
  · No readbacks. Don't say "so that's [X], correct?" — move on.
  · No "let me just confirm" / "just to be sure" / "did I get that right".
  · Drop filler acknowledgements ("perfect, thank you so much for that") —
    a quick "yep" or "righto" between questions is plenty.
  · Skip the "should only take a minute" preamble — start asking.
  · CLOSING is ONE short line, never a recap of what they told you.`,
    replace: `TONE
Friendly, conversational. ONE question per turn. Briefly verify each
answer before moving on (one beat, not a ceremony). Plain language unless
the customer uses trade terms first.

VERIFICATION PROTOCOL — apply on every content answer
  · After each answer, do a short readback before the next question.
    Example: "Righto, four downlights — got it. Next up…" or
    "Coogee, yep — and is the wiring already run?". One beat, then move on.
  · For JOB TYPE and SCOPE (what work they want done) — ALWAYS pin it
    down explicitly before classifying. If they say "I need some lights
    put in", respond: "Sure — by lights, do you mean downlights in the
    ceiling, or outdoor / deck lighting?". Don't classify on a guess.
  · If an answer is unclear, ambiguous, or you only caught part of it —
    ask again. Up to TWO clarifying follow-ups per question is fine.
    Examples:
      "Sorry mate, did you say four or fourteen downlights?"
      "Just to make sure I caught that — is that one ceiling fan or two?"
      "Could you say the suburb again for me?"
  · If after two clarifying tries you still can't get a clean answer,
    note it in scope.description as "[unclear: <what they said>]" and
    move on — don't stall the call.
  · NEVER assume on numbers, locations, or scope. Wrong inputs become a
    wrong quote. When in doubt, re-ask.

WHAT YOU DO NOT VERIFY (keep the call moving)
  · The caller's mobile is from caller ID. NEVER ask "what's the best
    number" or "is this the right mobile to text". Assume the calling
    number IS the contact number unless the caller volunteers a different
    one ("send it to my partner's phone…").
  · Don't ask them to spell their name unless the transcript clearly
    garbled it (one extra try is fine, after that move on).
  · Skip the "should only take a minute" preamble — straight into asking.
  · CLOSING stays ONE short line — per-question verification means you
    don't need to recap at the end.`,
  },
];

let applied = 0;
let alreadyApplied = 0;
for (const { label, find, replace } of edits) {
  if (sys.includes(replace)) {
    console.log(`      = ${label.padEnd(40)} already applied`);
    alreadyApplied++;
    continue;
  }
  if (!sys.includes(find)) {
    console.log(`      ✗ ${label.padEnd(40)} TARGET NOT FOUND — skipping`);
    continue;
  }
  sys = sys.replace(find, replace);
  console.log(`      ✓ ${label.padEnd(40)} applied`);
  applied++;
}
console.log(`      ${applied} applied, ${alreadyApplied} already in place`);
console.log(`      Prompt length: ${originalLen} → ${sys.length} chars`);

const newFirstMessage =
  "G'day, Jeff here from QuoteMate's AI quoting line. I'll take down the " +
  "details for your electrical job and we'll send a quote through. Call " +
  "may be recorded. First up — what's your name?";

const firstMessageChanged = a.firstMessage !== newFirstMessage;
console.log(`\n      First message: ${firstMessageChanged ? "updating" : "already set"}`);

console.log(`\n[3/4] PATCHing assistant...`);
const payload = {
  firstMessage: newFirstMessage,
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

console.log(`\n[4/4] Verifying...`);
const after = await vapi("GET", `/assistant/${VAPI_ASSISTANT_ID}`);
const v = after.data;
const verifiedSys = v.model?.messages?.find((m) => m.role === "system")?.content ?? "";

const checks = [
  ["ROLE introduces Jeff",                       verifiedSys.includes("You are Jeff")],
  ["ROLE has the AI-honesty fallback",           verifiedSys.includes("I'm an AI assistant")],
  ["VERIFICATION PROTOCOL block present",        verifiedSys.includes("VERIFICATION PROTOCOL")],
  ["readback example present",                   verifiedSys.includes("Righto, four downlights")],
  ["job-type clarify rule present",              verifiedSys.includes("by lights, do you mean")],
  ["two-tries fallback present",                 verifiedSys.includes("after two clarifying tries")],
  ["caller-ID mobile rule still present",        verifiedSys.includes("ALREADY captured from caller ID") || verifiedSys.includes("from caller ID")],
  ["First message introduces Jeff",              v.firstMessage?.includes("Jeff here")],
  ["First message asks for name directly",       v.firstMessage?.includes("what's your name")],
  ["No 'Sound good?' gate in first message",    !v.firstMessage?.includes("Sound good?")],
];

for (const [name, ok] of checks) {
  console.log(`      ${ok ? "✓" : "✗"} ${name}`);
}

console.log(`\n✓ Receptionist is now Jeff, and verifies content answers.`);
console.log(`  Prompt: ${originalLen} → ${verifiedSys.length} chars`);
console.log(`  First message:\n    "${v.firstMessage}"\n`);
console.log(`  Expected flow:`);
console.log(`    AI: "G'day, Jeff here from QuoteMate's AI quoting line… what's your name?"`);
console.log(`    YOU: "Anant"`);
console.log(`    AI: "Anant, righto. What suburb are you in?"`);
console.log(`    YOU: "Coogee"`);
console.log(`    AI: "Coogee, yep. What do you need done?"`);
console.log(`    YOU: "Some lights"`);
console.log(`    AI: "Sure — by lights, do you mean downlights in the ceiling,`);
console.log(`         or outdoor / deck lighting?" (clarifying job_type)`);
console.log(`    …\n`);

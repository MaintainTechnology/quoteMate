// ═══════════════════════════════════════════════════════════════════
// QuoteMate · Create the Vapi assistant (S3.3, S3.4, S3.5 from walkthrough)
//
// Usage:  node --env-file=.env.local scripts/setup-vapi-assistant.mjs
//
// Optional env: VAPI_SERVER_URL=https://your-ngrok-url.ngrok-free.app/api/vapi/webhook
//
// Pulls the system prompt verbatim from build-guide.html step 6,
// picks an Australian-accent ElevenLabs voice, and POSTs the full
// assistant config to the Vapi API. Equivalent to clicking through
// S3.3 (create) + S3.4 (system prompt) + S3.5 (server URL) in the dashboard.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const VAPI_SERVER_URL = process.env.VAPI_SERVER_URL;

if (!VAPI_API_KEY) {
  console.error("Missing VAPI_API_KEY in .env.local");
  process.exit(1);
}

// ─── 1. Extract system prompt from build-guide.html ────────────────
const here = dirname(fileURLToPath(import.meta.url));
const guidePath = join(here, "..", "public", "docs", "build-guide.html");
const html = readFileSync(guidePath, "utf8");

function stripHtml(s) {
  return s
    .replace(/\r\n/g, "\n")              // normalise CRLF → LF
    .replace(/<\/?span[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const cleaned = stripHtml(html);
// Use a flexible start marker — match "ROLE" then any whitespace then "You are an AI receptionist"
const startRe = /ROLE\s*\n\s*You are an AI receptionist/;
const endMarker = "- Skip photo asks for switchboard / EV / outdoor / oven jobs";
const startMatch = cleaned.match(startRe);
const endIdx = cleaned.indexOf(endMarker);
if (!startMatch || endIdx < 0) {
  console.error("Couldn't locate system-prompt boundaries in build-guide.html");
  console.error(`  start regex match: ${startMatch ? "yes at " + startMatch.index : "NO"}`);
  console.error(`  end marker found:  ${endIdx >= 0 ? "yes at " + endIdx : "NO"}`);
  console.error(`  Has "ROLE":     ${cleaned.includes("ROLE")}`);
  console.error(`  Has "You are an AI receptionist": ${cleaned.includes("You are an AI receptionist")}`);
  process.exit(1);
}
const startIdx = startMatch.index;
const systemPrompt = cleaned.slice(startIdx, endIdx + endMarker.length);
console.log(`\n[1/4] Extracted system prompt (${systemPrompt.length.toLocaleString()} chars)`);
console.log(`      starts: "${systemPrompt.slice(0, 60)}..."`);
console.log(`      ends:   "...${systemPrompt.slice(-60)}"`);

// ─── 2. Pick an Australian ElevenLabs voice ────────────────────────
console.log("\n[2/4] Querying ElevenLabs for an Australian voice...");

let voiceId = null;
let voiceName = null;
let voiceAccent = null;

if (ELEVENLABS_API_KEY) {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
  });
  if (res.ok) {
    const { voices } = await res.json();
    console.log(`      Found ${voices.length} voices in your ElevenLabs library.`);

    const auMatches = voices.filter((v) =>
      JSON.stringify(v.labels || {}).toLowerCase().includes("australian")
    );
    const britMatches = voices.filter((v) =>
      JSON.stringify(v.labels || {}).toLowerCase().includes("british")
    );
    const englishMatches = voices.filter((v) => {
      const lbls = JSON.stringify(v.labels || {}).toLowerCase();
      return lbls.includes("english") || lbls.includes("american");
    });

    const picked = auMatches[0] ?? britMatches[0] ?? englishMatches[0] ?? voices[0];
    voiceId = picked.voice_id;
    voiceName = picked.name;
    voiceAccent = picked.labels?.accent ?? "(unknown accent)";

    if (auMatches[0]) console.log(`      ✓ Australian voice found: "${voiceName}" (${voiceAccent})`);
    else if (britMatches[0]) console.log(`      ⚠ No Australian voice in your library; using British: "${voiceName}"`);
    else console.log(`      ⚠ No Australian or British voice in your library; using: "${voiceName}" (${voiceAccent})`);

    console.log(`      voice_id = ${voiceId}`);
  } else {
    const txt = await res.text();
    console.log(`      ✗ Couldn't fetch voices (HTTP ${res.status}): ${txt.slice(0, 200)}`);
  }
}

if (!voiceId) {
  // Fallback: a known ElevenLabs default voice ID
  voiceId = "21m00Tcm4TlvDq8ikWAM"; // Rachel
  voiceName = "Rachel (fallback default)";
  console.log(`      ⚠ Using fallback default voice: ${voiceName}`);
}

// ─── 3. Build the assistant payload ────────────────────────────────
// Transcriber: Deepgram Nova-3 with en-AU and a keyword boost list.
// Boosts trade jargon, acronyms, brand names, and AU suburb names —
// the words Deepgram has weak priors on. Keep this list in sync with
// scripts/update-vapi-transcriber.mjs (the patch script for existing
// assistants on the new Vapi account).
// Vapi's `keywords` field accepts SINGLE TOKENS only. Multi-word entries
// like "power point" or "Surry Hills" cause HTTP 400. Trade compounds
// ("ceiling fan", "smoke alarm") are common enough that Deepgram en-AU
// handles them unboosted — boost only irregular jargon + acronyms.
const TRANSCRIBER_KEYWORDS = [
  "downlight:2", "downlights:2",
  "GPO:3", "GPOs:3",
  "switchboard:2",
  "bollard:1",
  "fault:1",
  "oven:1", "cooktop:1", "rangehood:1",
  "RCD:3", "MCB:3", "RCBO:3", "LED:2", "LEDs:2", "IP65:2",
  "dimmable:2", "dimmer:1", "halogen:1",
  "tri-colour:2", "tri-color:2",
  "weatherproof:1",
  "QuoteMate:3", "Jon:2",
  "Clipsal:1", "HPM:1", "NEC:1",
  "Bondi:1", "Paddington:1", "Coogee:1", "Redfern:1",
  "Newtown:1", "Marrickville:1", "Manly:1", "Glebe:1",
  "Erskineville:1", "Chatswood:1", "Randwick:1",
  "sparky:1", "sparkies:1",
];

const payload = {
  name: "QuoteMate Receptionist",
  transcriber: {
    provider: "deepgram",
    model: "nova-3",
    language: "en-AU",
    keywords: TRANSCRIBER_KEYWORDS,
    smartFormat: true,
    endpointing: 300,
  },
  voice: {
    provider: "11labs",
    voiceId,
  },
  model: {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    temperature: 0.4,
    maxTokens: 250,
    messages: [{ role: "system", content: systemPrompt }],
  },
  firstMessage:
    "G'day, you've reached the AI quoting line for [your business name]. " +
    "I can take down all the details for your electrical job and have a quote sent through. " +
    "This call may be recorded for quality and quote-drafting purposes. Sound good?",
};

if (VAPI_SERVER_URL) {
  payload.server = { url: VAPI_SERVER_URL };
  console.log(`\n[3/4] Server URL will be set to: ${VAPI_SERVER_URL}`);
} else {
  console.log(`\n[3/4] No VAPI_SERVER_URL provided — assistant will be created without a server URL.`);
  console.log(`      You can set it later by re-running with VAPI_SERVER_URL=... in env.`);
}

// ─── 4. POST to Vapi ───────────────────────────────────────────────
console.log("\n[4/4] Creating assistant via Vapi API...");

const res = await fetch("https://api.vapi.ai/assistant", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${VAPI_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
let data;
try { data = JSON.parse(text); } catch { data = text; }

if (!res.ok) {
  console.error(`\n✗ Failed: HTTP ${res.status}`);
  console.error(typeof data === "string" ? data : JSON.stringify(data, null, 2));
  process.exit(1);
}

console.log(`\n✓ Assistant created.`);
console.log(`  ID:           ${data.id}`);
console.log(`  Name:         ${data.name}`);
console.log(`  Transcriber:  ${data.transcriber?.provider} · ${data.transcriber?.model} · ${data.transcriber?.language}`);
console.log(`  Voice:        ${data.voice?.provider} · ${voiceName}`);
console.log(`  Model:        ${data.model?.provider} · ${data.model?.model} · temp=${data.model?.temperature} · maxTokens=${data.model?.maxTokens}`);
console.log(`  System prompt: ${data.model?.messages?.[0]?.content?.length ?? 0} chars`);
console.log(`  First message: "${data.firstMessage?.slice(0, 70)}..."`);
console.log(`  Server URL:   ${data.server?.url ?? "(not set)"}`);

console.log(`\nNext step — save the assistant ID, then add this line to .env.local:`);
console.log(`  VAPI_ASSISTANT_ID=${data.id}\n`);

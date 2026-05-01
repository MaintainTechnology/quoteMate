// Inspect the current Vapi assistant config — Server URL, model, prompt,
// voice, first message, end behavior, attached phone numbers.
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID;

if (!VAPI_API_KEY || !VAPI_ASSISTANT_ID) {
  console.error("Missing VAPI_API_KEY or VAPI_ASSISTANT_ID");
  process.exit(1);
}

async function vapi(path) {
  const r = await fetch(`https://api.vapi.ai${path}`, {
    headers: { Authorization: `Bearer ${VAPI_API_KEY}` },
  });
  if (!r.ok) {
    console.error(`✗ ${path} → HTTP ${r.status}`);
    console.error(await r.text());
    return null;
  }
  return r.json();
}

const a = await vapi(`/assistant/${VAPI_ASSISTANT_ID}`);
if (!a) process.exit(1);

console.log(`\n=== Assistant: ${a.name} (${a.id}) ===`);
console.log(`createdAt:        ${a.createdAt}`);
console.log(`updatedAt:        ${a.updatedAt}`);

console.log(`\n--- Server (webhook destination) ---`);
console.log(`server.url:       ${a.server?.url ?? "(none)"}`);
console.log(`server.timeoutSec:${a.server?.timeoutSeconds ?? "(default)"}`);

console.log(`\n--- Model (the brain during the call) ---`);
console.log(`provider:         ${a.model?.provider}`);
console.log(`model:            ${a.model?.model}`);
console.log(`temperature:      ${a.model?.temperature ?? "(default)"}`);

console.log(`\n--- System prompt (first 2000 chars) ---`);
const sysMsg = a.model?.messages?.find((m) => m.role === "system");
console.log(sysMsg ? sysMsg.content.slice(0, 2000) : "(no system message)");
if (sysMsg && sysMsg.content.length > 2000) {
  console.log(`... [truncated, total ${sysMsg.content.length} chars]`);
}

console.log(`\n--- First message (what assistant says when call connects) ---`);
console.log(a.firstMessage ?? "(none — assistant waits for caller to speak first)");

console.log(`\n--- Voice ---`);
console.log(`provider:         ${a.voice?.provider}`);
console.log(`voiceId:          ${a.voice?.voiceId}`);

console.log(`\n--- Transcriber (speech → text) ---`);
console.log(`provider:         ${a.transcriber?.provider}`);
console.log(`model:            ${a.transcriber?.model}`);
console.log(`language:         ${a.transcriber?.language ?? "(default)"}`);

console.log(`\n--- End-of-call behavior ---`);
console.log(`endCallMessage:   ${a.endCallMessage ?? "(none)"}`);
console.log(`endCallPhrases:   ${JSON.stringify(a.endCallPhrases ?? [])}`);
console.log(`maxDurationSec:   ${a.maxDurationSeconds ?? "(default)"}`);
console.log(`silenceTimeoutSec:${a.silenceTimeoutSeconds ?? "(default)"}`);

console.log(`\n--- Server messages enabled (which events get POSTed) ---`);
console.log(JSON.stringify(a.serverMessages ?? "(default)", null, 2));

// Phone numbers attached to this assistant
console.log(`\n--- Phone numbers on this Vapi account ---`);
const numbers = await vapi(`/phone-number`);
if (numbers && Array.isArray(numbers)) {
  for (const n of numbers) {
    const isOurs = n.assistantId === VAPI_ASSISTANT_ID;
    console.log(
      `  ${isOurs ? "→" : " "} ${n.number ?? "(no number)"}  ` +
      `provider=${n.provider} ` +
      `assistantId=${n.assistantId ?? "(none)"} ` +
      `${isOurs ? "← attached to THIS assistant" : ""}`
    );
  }
} else {
  console.log("(could not fetch phone numbers)");
}

console.log(``);

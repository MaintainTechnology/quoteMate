// ═══════════════════════════════════════════════════════════════════
// QuoteMate · Master Vapi tuning script — runs all post-migration
// tuning passes in one shot.
//
// Use this any time you've migrated to a new Vapi account, swapped
// the assistant, or want to reset Jon's behaviour to the canonical
// production config. Each child is idempotent so re-running is safe.
//
// Order matters slightly:
//   1. transcriber       — Deepgram Nova-3 + en-AU + keyword boosts
//   2. end-call config   — endCall tool + phrases + timeouts
//   3. speed config      — tighter closing/opening, no readback
//   4. stop-speaking     — interrupt sensitivity tuning
//
// Usage:  node --env-file=.env.local scripts/update-vapi-jon-tuning.mjs
//
// Env required:  VAPI_API_KEY  +  VAPI_ASSISTANT_ID
// ═══════════════════════════════════════════════════════════════════

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const scripts = [
  {
    name: "transcriber",
    file: "update-vapi-transcriber.mjs",
    purpose: "Deepgram Nova-3 + en-AU + 52 keyword boosts",
  },
  {
    name: "end-call",
    file: "update-vapi-end-call-config.mjs",
    purpose: "endCall tool + 29 farewell phrases + silence/duration caps",
  },
  {
    name: "speed",
    file: "update-vapi-speed-config.mjs",
    purpose: "Tighter closing/opening, no echo-backs, single-line wraps",
  },
  {
    name: "stop-speaking",
    file: "update-vapi-stop-speaking-plan.mjs",
    purpose: "Interrupt sensitivity — no cut-offs, no awkward pauses",
  },
];

function runScript(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--env-file=.env.local", join(here, file)],
      { stdio: "inherit", env: process.env }
    );
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`exit code ${code}`));
    });
    child.on("error", reject);
  });
}

const HR = "═".repeat(72);
console.log(`\n${HR}`);
console.log(`  Vapi master tuning — ${scripts.length} passes`);
console.log(HR);

const results = [];
for (let i = 0; i < scripts.length; i++) {
  const s = scripts[i];
  console.log(`\n${HR}`);
  console.log(`  [${i + 1}/${scripts.length}] ${s.name.toUpperCase()}`);
  console.log(`        ${s.purpose}`);
  console.log(HR);
  try {
    await runScript(s.file);
    results.push({ ...s, ok: true });
  } catch (e) {
    console.error(`\n✗ ${s.name} pass failed: ${e.message}`);
    results.push({ ...s, ok: false, error: e.message });
  }
}

console.log(`\n${HR}`);
console.log(`  SUMMARY`);
console.log(HR);
for (const r of results) {
  const icon = r.ok ? "✓" : "✗";
  console.log(`  ${icon}  ${r.name.padEnd(15)}  ${r.purpose}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length === 0) {
  console.log(`\n  All ${scripts.length} passes applied successfully.`);
  console.log(`  Test by dialling the Vapi number — Jon should now:`);
  console.log(`    · Capture trade jargon correctly (downlights, GPOs, RCDs)`);
  console.log(`    · End the call cleanly when you say "thanks, that's everything"`);
  console.log(`    · Skip readbacks and confirmations — straight to the next question`);
  console.log(`    · Not cut you off mid-sentence and not pause awkwardly between turns`);
} else {
  console.log(`\n  ${failed.length}/${results.length} passes failed:`);
  for (const f of failed) console.log(`    · ${f.name}: ${f.error}`);
  console.log(`\n  Re-running this script will retry the failed passes (idempotent).`);
}

process.exit(failed.length === 0 ? 0 : 1);

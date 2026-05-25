// Run the live preview/sample prompt builder for a given quote and
// print what would actually be sent to Gemini. Verifies that customer
// choices (verbatim words, anchor product, count, suburb) all flow
// through.
//
// Usage:
//   node --env-file=.env.local scripts/preview-gemini-prompt.mjs --token <share_token>

import { createClient } from "@supabase/supabase-js";
import { buildPreviewPrompt, buildSamplePrompts } from "../lib/ig-engine/prompts.ts";
import { loadPromptContext } from "../lib/ig-engine/generate.ts";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const i = process.argv.indexOf("--token");
const token = i >= 0 ? process.argv[i + 1] : null;
if (!token) { console.error("Need --token <share_token>"); process.exit(1); }

const { data: quote } = await supabase
  .from("quotes")
  .select("id, intake_id")
  .eq("share_token", token)
  .maybeSingle();
if (!quote) { console.error("quote not found"); process.exit(1); }

const { data: intake } = await supabase
  .from("intakes")
  .select("id, trade, job_type, scope, access, property, caller, timing")
  .eq("id", quote.intake_id)
  .maybeSingle();
if (!intake) { console.error("intake not found"); process.exit(1); }

const ctx = await loadPromptContext(quote.id, intake);

console.log("═══════════════════════════════════════════════════════════════");
console.log("ANCHOR PRODUCT picked by prompt builder:");
console.log("═══════════════════════════════════════════════════════════════");
const tier = ctx.quote?.selected_tier ?? "better";
const tierItems = (ctx.lineItems ?? []).filter(li => li.tier === tier);
console.log(`  selected_tier=${tier}`);
console.log(`  line items in selected tier: ${tierItems.length}`);
for (const li of tierItems) {
  console.log(`    - ${li.description} (qty=${li.quantity ?? "-"}, src=${li.source ?? "-"})`);
}

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("PREVIEW PROMPT (systemInstruction sent to Gemini):");
console.log("═══════════════════════════════════════════════════════════════");
const preview = buildPreviewPrompt(ctx);
console.log(preview.system);

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("SAMPLE WIDE-SHOT PROMPT:");
console.log("═══════════════════════════════════════════════════════════════");
const samples = buildSamplePrompts(ctx, { usePhotoReference: false });
if (samples) {
  console.log(samples.wide.system);
} else {
  console.log("(buildSamplePrompts returned null - no prompts for this job_type)");
}

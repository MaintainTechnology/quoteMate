// QuoteMate · re-embed every intake with Voyage voyage-3-large (1024 dim).
//
// Run AFTER migration 057_voyage3_large_1024.sql has wiped intakes.embedding
// and resized the column to vector(1024).
//
// Usage:
//   node --env-file=.env.staging.local scripts/reembed-intakes-voyage3-large.mjs
//   node --env-file=.env.local         scripts/reembed-intakes-voyage3-large.mjs
//
// Optional flags:
//   --dry-run    Print intake summaries + would-be embed inputs, don't call Voyage, don't write.
//   --limit=N    Only process the first N intakes (useful for spot-checking).
//
// Idempotent: re-running is safe — it overwrites whatever embedding is there
// with a fresh voyage-3-large vector. The match_intakes() RPC reads whatever's
// in the column at query time, so a partial re-embed degrades gracefully
// (matched rows are scored, unmatched rows are skipped at the IS NOT NULL gate).

import pg from "pg";

const { Client } = pg;

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
if (!VOYAGE_API_KEY) {
  console.error("Missing VOYAGE_API_KEY in env — cannot call Voyage API");
  process.exit(1);
}
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL (use --env-file=.env.local or .env.staging.local)");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;
const target = dbUrl.includes("bobvihqwhtcbxneelfns") ? "PRODUCTION" : "staging";

const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

// Mirror lib/intake/embed.ts buildSummary(). Kept inline so the script has
// no app-side import dependencies (runs standalone via node --env-file=…).
function buildSummary(intake) {
  const trade = intake.trade ?? "electrical";
  const jobType = intake.job_type ?? "unknown";
  const scope = intake.scope ?? {};
  const itemCount = scope.item_count ?? "?";
  const isNewInstall = scope.is_new_install ?? "?";
  const indoorOutdoor = scope.indoor_outdoor ?? "";
  const risks = Array.isArray(intake.risks) ? intake.risks.join(" ") : "";
  return `trade=${trade} ${jobType} count=${itemCount} new=${isNewInstall} ${indoorOutdoor} ${risks}`.trim();
}

async function embedWithVoyage3Large(text) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: [text], model: "voyage-3-large" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`Voyage HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const v = data?.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length !== 1024) {
    throw new Error(`Expected 1024-dim vector, got length=${Array.isArray(v) ? v.length : "non-array"}`);
  }
  return v;
}

try {
  await c.connect();

  const { rows: intakes } = await c.query(
    `select id, trade, job_type, scope, risks
       from intakes
       order by created_at asc
       ${limit ? `limit ${limit}` : ""}`,
  );

  console.log(`Re-embedding ${intakes.length} intakes on ${target}${dryRun ? " (DRY RUN — no API calls, no writes)" : ""}...`);
  if (limit) console.log(`  --limit=${limit} applied`);

  let ok = 0, failed = 0, skipped = 0;
  const failures = [];

  for (let i = 0; i < intakes.length; i++) {
    const row = intakes[i];
    const summary = buildSummary(row);

    if (!summary || summary.length < 5) {
      console.log(`  [${i + 1}/${intakes.length}] ${row.id} — SKIPPED (empty summary)`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  [${i + 1}/${intakes.length}] ${row.id} — summary: ${summary.slice(0, 100)}`);
      ok++;
      continue;
    }

    try {
      const vector = await embedWithVoyage3Large(summary);
      // pgvector accepts a stringified array literal "[v1,v2,...]".
      const vectorLiteral = "[" + vector.join(",") + "]";
      await c.query(`update intakes set embedding = $1::vector where id = $2`, [vectorLiteral, row.id]);
      ok++;
      if (ok % 25 === 0 || i === intakes.length - 1) {
        console.log(`  [${i + 1}/${intakes.length}] ${ok} embedded, ${failed} failed, ${skipped} skipped`);
      }
    } catch (err) {
      failed++;
      failures.push({ id: row.id, error: err.message ?? String(err) });
      console.error(`  [${i + 1}/${intakes.length}] ${row.id} — FAILED: ${err.message ?? err}`);
    }
  }

  console.log(`\nDone on ${target}:`);
  console.log(`  embedded:  ${ok}`);
  console.log(`  failed:    ${failed}`);
  console.log(`  skipped:   ${skipped}`);
  if (failures.length > 0 && failures.length <= 10) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ${f.id}  ${f.error}`);
  }

  // Verify with a count.
  if (!dryRun) {
    const { rows: post } = await c.query(
      `select count(*)::int as total, count(embedding)::int as with_embedding from intakes`,
    );
    console.log(`\nPost-state on ${target}:`);
    console.log(`  intakes total:           ${post[0].total}`);
    console.log(`  intakes with embedding:  ${post[0].with_embedding}`);
  }

  if (failed > 0) process.exit(1);
} catch (err) {
  console.error("Re-embed script failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}

// QuoteMate · run migration 051 (trade CHECK→FK swap + retired_at)
// Usage: node --env-file=.env.local scripts/run-migration-051.mjs
//
// The one Phase 0 migration that ALTERs existing tables. Pre-flight
// confirms every `trade` value across the 4 tables is already a known
// trade (so the FK ADD cannot fail); post-verify confirms the 4 CHECKs
// are gone, the 4 FKs exist, and shared_assemblies.retired_at is added.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(here, "..", "sql", "migrations", "051_trade_fk_swap.sql");
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

// The 7 tables that carry the trade CHECK (authoritative pg_constraint
// query, 2026-05-21) — corrects the spec's earlier 4-table list.
const TABLES = [
  "shared_assembly_bom",
  "supplier_catalogue",
  "tenant_assembly_bom",
  "tenant_custom_assemblies",
  "tenant_licences",
  "tenant_material_catalogue",
  "tenants",
];
const sql = readFileSync(sqlPath, "utf8");
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();

  // ── PRE-FLIGHT — every trade value must already be a known trade ──
  const { rows: known } = await c.query("select name from trades");
  const knownTrades = new Set(known.map((r) => r.name));
  if (knownTrades.size === 0) {
    console.error("PRE-FLIGHT FAIL: trades empty — run migration 046 first");
    process.exit(1);
  }
  for (const tbl of TABLES) {
    const { rows: bad } = await c.query(
      `select distinct trade from ${tbl} where trade is not null and trade <> all($1::text[])`,
      [[...knownTrades]],
    );
    if (bad.length > 0) {
      console.error(`PRE-FLIGHT FAIL: ${tbl} has trade values not in trades:`, bad.map((b) => b.trade));
      process.exit(1);
    }
  }
  console.log(`  ✓ pre-flight: all trade values across ${TABLES.length} tables are known trades`);

  // ── APPLY ─────────────────────────────────────────────────────────
  console.log(`\n→ Running 051_trade_fk_swap.sql (${sql.length.toLocaleString()} chars)...`);
  await c.query(sql);
  console.log("OK migration applied");

  // ── POST-VERIFY ───────────────────────────────────────────────────
  let bad = 0;
  for (const tbl of TABLES) {
    const { rows: chk } = await c.query(
      `select count(*)::int n from pg_constraint
        where conrelid = $1::regclass and contype = 'c'
          and pg_get_constraintdef(oid) ilike '%trade%'`,
      [tbl],
    );
    const { rows: fk } = await c.query(
      `select count(*)::int n from pg_constraint
        where conrelid = $1::regclass and contype = 'f' and conname = $2`,
      [tbl, `${tbl}_trade_fk`],
    );
    const checkGone = chk[0].n === 0;
    const fkThere = fk[0].n === 1;
    if (checkGone && fkThere) {
      console.log(`  ✓ ${tbl}: CHECK dropped, FK present`);
    } else {
      console.error(`  ✗ ${tbl}: check_gone=${checkGone} fk_present=${fkThere}`);
      bad++;
    }
  }
  const { rows: col } = await c.query(`
    select count(*)::int n from information_schema.columns
     where table_schema='public' and table_name='shared_assemblies'
       and column_name='retired_at'`);
  if (col[0].n === 1) {
    console.log("  ✓ shared_assemblies.retired_at present");
  } else {
    console.error("  ✗ shared_assemblies.retired_at missing");
    bad++;
  }

  if (bad > 0) {
    console.error(`\nFAIL — ${bad} post-verify check(s) failed.`);
    process.exit(1);
  }
  console.log("\nOK — migration 051 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}

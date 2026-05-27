// QuoteMate · run migration 075 (A5 invoice calibration tables)
// Usage:  node --env-file=.env.local scripts/run-migration-075.mjs
//
// Adds three tables: invoice_uploads, invoice_extractions, pricing_suggestions
// + a shared touch_updated_at() trigger function. Idempotent: re-runs are
// safe because every CREATE uses IF NOT EXISTS and the trigger is dropped-
// before-create.
//
// Pre-flight: snapshots whether each of the three tables already exists.
// Post-verify: confirms all three exist with RLS enabled, the indexes are
// present, and the touch_updated_at trigger is wired on the two mutable
// tables.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(
  here,
  "..",
  "sql",
  "migrations",
  "075_invoice_calibration_tables.sql",
);

const TABLES = ["invoice_uploads", "invoice_extractions", "pricing_suggestions"];

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error("Missing SUPABASE_DB_URL in .env.local");
  process.exit(1);
}

const sql = readFileSync(sqlPath, "utf8");
const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

try {
  await c.connect();

  // ── PRE-FLIGHT ─────────────────────────────────────────────────
  console.log("\nPre-flight checks:");
  for (const t of TABLES) {
    const { rows } = await c.query(
      `select 1 from information_schema.tables
         where table_schema = 'public' and table_name = $1`,
      [t],
    );
    console.log(`  table ${t} exists pre-apply: ${rows.length > 0}`);
  }

  // ── APPLY ──────────────────────────────────────────────────────
  console.log(
    `\n-> Applying 075_invoice_calibration_tables.sql (${sql.length.toLocaleString()} chars)...`,
  );
  await c.query(sql);
  console.log("OK migration applied");

  // ── POST-VERIFY ────────────────────────────────────────────────
  console.log("\nPost-verify:");

  for (const t of TABLES) {
    const { rows } = await c.query(
      `select 1 from information_schema.tables
         where table_schema = 'public' and table_name = $1`,
      [t],
    );
    if (rows.length === 0) {
      console.error(`POST-VERIFY FAIL: table public.${t} missing after apply`);
      process.exit(1);
    }
    const { rows: rlsRows } = await c.query(
      `select relrowsecurity from pg_class
         where relname = $1 and relnamespace = 'public'::regnamespace`,
      [t],
    );
    if (!rlsRows[0]?.relrowsecurity) {
      console.error(`POST-VERIFY FAIL: RLS not enabled on public.${t}`);
      process.exit(1);
    }
    console.log(`  OK ${t} exists · RLS=on`);
  }

  // Confirm key columns on each table.
  const colChecks = [
    {
      table: "invoice_uploads",
      required: ["tenant_id", "storage_path", "status", "created_at"],
    },
    {
      table: "invoice_extractions",
      required: ["upload_id", "tenant_id", "raw", "total_inc_gst", "scope_description"],
    },
    {
      table: "pricing_suggestions",
      required: ["tenant_id", "field", "current_value", "suggested_value", "trust", "status"],
    },
  ];
  for (const check of colChecks) {
    const { rows } = await c.query(
      `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = $1`,
      [check.table],
    );
    const have = new Set(rows.map((r) => r.column_name));
    const missing = check.required.filter((c) => !have.has(c));
    if (missing.length > 0) {
      console.error(
        `POST-VERIFY FAIL: ${check.table} missing columns: ${missing.join(", ")}`,
      );
      process.exit(1);
    }
    console.log(`  OK ${check.table} columns: ${check.required.join(", ")}`);
  }

  // Confirm indexes
  const indexChecks = [
    "invoice_uploads_tenant_idx",
    "invoice_extractions_tenant_idx",
    "invoice_extractions_upload_idx",
    "pricing_suggestions_tenant_pending_idx",
  ];
  for (const idx of indexChecks) {
    const { rows } = await c.query(
      `select 1 from pg_indexes where schemaname = 'public' and indexname = $1`,
      [idx],
    );
    if (rows.length === 0) {
      console.error(`POST-VERIFY FAIL: index ${idx} missing`);
      process.exit(1);
    }
    console.log(`  OK index ${idx}`);
  }

  // Confirm triggers
  const triggerChecks = ["invoice_uploads_touch", "pricing_suggestions_touch"];
  for (const trig of triggerChecks) {
    const { rows } = await c.query(
      `select 1 from pg_trigger where tgname = $1 and not tgisinternal`,
    [trig],
    );
    if (rows.length === 0) {
      console.error(`POST-VERIFY FAIL: trigger ${trig} missing`);
      process.exit(1);
    }
    console.log(`  OK trigger ${trig}`);
  }

  // Confirm pricing_suggestions check constraint accepts only the listed enums.
  const { rows: chk } = await c.query(
    `select 1 from pg_constraint
       where conrelid = 'public.pricing_suggestions'::regclass
         and contype = 'c'`,
  );
  if (chk.length === 0) {
    console.error("POST-VERIFY FAIL: pricing_suggestions has no CHECK constraints");
    process.exit(1);
  }
  console.log(`  OK pricing_suggestions has ${chk.length} CHECK constraint(s)`);

  console.log("\nOK migration 075 verified.");
} catch (err) {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
} finally {
  await c.end();
}

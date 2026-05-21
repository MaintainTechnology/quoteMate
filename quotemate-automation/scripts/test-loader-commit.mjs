// End-to-end verification of the admin bulk loader commit/rollback
// (migration 052) — the Phase 1 exit-gate test: bulk-add test services,
// verify, roll the batch back cleanly.
//
// Runs against PROD but only ever touches ZZZ_LOADER_TEST_* rows, and the
// finally block deletes them + the test batches no matter what. Exercises:
// NEW insert, UPDATE with before-values, rollback-restore, rollback-delete,
// and commit/rollback idempotency.
//
// Usage: node --env-file=.env.local scripts/test-loader-commit.mjs

import pg from "pg";

const { Client } = pg;
const PREFIX = "ZZZ_LOADER_TEST_";
const c = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}

async function cleanup() {
  await c.query(`delete from shared_assemblies where name like $1`, [`${PREFIX}%`]);
  await c.query(`delete from shared_materials  where name like $1`, [`${PREFIX}%`]);
  await c.query(`delete from import_batches where source = 'loader-commit-test'`);
}

async function createBatch(key) {
  const { rows } = await c.query(
    `insert into import_batches (idempotency_key, admin_user_id, source, status)
     values ($1, gen_random_uuid(), 'loader-commit-test', 'staged') returning id`,
    [key],
  );
  return rows[0].id;
}

async function stage(batchId, table, rowClass, payload) {
  await c.query(
    `insert into import_staged_rows
       (batch_id, target_table, row_class, payload, validation_status, smoke_status)
     values ($1, $2, $3, $4, 'passed', 'passed')`,
    [batchId, table, rowClass, JSON.stringify(payload)],
  );
}

const asm = (name, price) => ({
  trade: "electrical",
  name: `${PREFIX}${name}`,
  description: "loader test row",
  default_unit: "each",
  default_unit_price_ex_gst: price,
  default_labour_hours: 1,
  default_exclusions: "none",
  category: "general",
  clarifying_questions: [],
  default_enabled: false,
});
const mat = (name, price) => ({
  trade: "electrical",
  name: `${PREFIX}${name}`,
  brand: "TestBrand",
  unit: "each",
  default_unit_price_ex_gst: price,
});

try {
  await c.connect();
  await cleanup(); // clear any leftovers from a prior run

  // ── Batch A — 3 NEW assemblies + 2 NEW materials ───────────────────
  const batchA = await createBatch(`loader-test-A-${Date.now()}`);
  await stage(batchA, "shared_assemblies", "NEW", asm("downlight", 30));
  await stage(batchA, "shared_assemblies", "NEW", asm("gpo", 25));
  await stage(batchA, "shared_assemblies", "NEW", asm("fan", 40));
  await stage(batchA, "shared_materials", "NEW", mat("cable", 12));
  await stage(batchA, "shared_materials", "NEW", mat("conduit", 8));

  const commitA = (await c.query(`select commit_import_batch($1) r`, [batchA])).rows[0].r;
  check("commit A reports 5 rows committed", commitA.committed === 5);

  const asmCount = (await c.query(
    `select count(*)::int n from shared_assemblies where name like $1`, [`${PREFIX}%`],
  )).rows[0].n;
  const matCount = (await c.query(
    `select count(*)::int n from shared_materials where name like $1`, [`${PREFIX}%`],
  )).rows[0].n;
  check("3 test assemblies landed in shared_assemblies", asmCount === 3);
  check("2 test materials landed in shared_materials", matCount === 2);

  // ── Idempotency — committing A again must be a no-op ───────────────
  const commitA2 = (await c.query(`select commit_import_batch($1) r`, [batchA])).rows[0].r;
  check("re-commit A is idempotent (already_committed)", commitA2.already_committed === true);
  const asmCount2 = (await c.query(
    `select count(*)::int n from shared_assemblies where name like $1`, [`${PREFIX}%`],
  )).rows[0].n;
  check("re-commit A did NOT duplicate rows (still 3)", asmCount2 === 3);

  // ── Batch B — UPDATE one assembly's price ──────────────────────────
  const beforePrice = Number((await c.query(
    `select default_unit_price_ex_gst p from shared_assemblies where name = $1`,
    [`${PREFIX}downlight`],
  )).rows[0].p);
  const batchB = await createBatch(`loader-test-B-${Date.now()}`);
  await stage(batchB, "shared_assemblies", "UPDATE", asm("downlight", 99));
  const commitB = (await c.query(`select commit_import_batch($1) r`, [batchB])).rows[0].r;
  check("commit B reports 1 row committed", commitB.committed === 1);
  const updatedPrice = Number((await c.query(
    `select default_unit_price_ex_gst p from shared_assemblies where name = $1`,
    [`${PREFIX}downlight`],
  )).rows[0].p);
  check("UPDATE changed the price to 99", updatedPrice === 99);

  // ── Rollback B — must restore the captured before-value ────────────
  const rbB = (await c.query(`select rollback_import_batch($1) r`, [batchB])).rows[0].r;
  check("rollback B reverted 1 row", rbB.reverted === 1);
  const restoredPrice = Number((await c.query(
    `select default_unit_price_ex_gst p from shared_assemblies where name = $1`,
    [`${PREFIX}downlight`],
  )).rows[0].p);
  check(`rollback B restored the price to ${beforePrice}`, restoredPrice === beforePrice);

  // ── Rollback A — must delete all 5 inserted rows ───────────────────
  const rbA = (await c.query(`select rollback_import_batch($1) r`, [batchA])).rows[0].r;
  check("rollback A deleted 5 rows", rbA.deleted === 5);
  const leftAsm = (await c.query(
    `select count(*)::int n from shared_assemblies where name like $1`, [`${PREFIX}%`],
  )).rows[0].n;
  const leftMat = (await c.query(
    `select count(*)::int n from shared_materials where name like $1`, [`${PREFIX}%`],
  )).rows[0].n;
  check("no test assemblies remain after rollback A", leftAsm === 0);
  check("no test materials remain after rollback A", leftMat === 0);

  // ── Idempotency — rolling A back again is a no-op ──────────────────
  const rbA2 = (await c.query(`select rollback_import_batch($1) r`, [batchA])).rows[0].r;
  check("re-rollback A is idempotent (already_rolled_back)", rbA2.already_rolled_back === true);

  console.log(`\n${pass} passed · ${fail} failed`);
} catch (err) {
  console.error("Test threw:", err.message ?? err);
  fail++;
} finally {
  try {
    await cleanup();
    console.log("cleaned up all ZZZ_LOADER_TEST_ rows + test batches");
  } catch (e) {
    console.error("CLEANUP FAILED — check for stray ZZZ_LOADER_TEST_ rows:", e.message ?? e);
  }
  await c.end();
}

process.exit(fail > 0 ? 1 : 0);

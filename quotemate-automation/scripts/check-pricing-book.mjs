// Dump the plumbing entries in shared_assemblies and shared_materials.

import pg from "pg";
const { Client } = pg;
const dbUrl = process.env.SUPABASE_DB_URL;
const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

console.log("=== shared_assemblies (plumbing) ===");
const a = await client.query(
  `select * from shared_assemblies where trade='plumbing' order by name limit 50`
);
for (const r of a.rows) console.log(" ", JSON.stringify(r));

console.log("\n=== shared_materials (plumbing) ===");
const m = await client.query(
  `select * from shared_materials where trade='plumbing' order by name limit 50`
);
for (const r of m.rows) console.log(" ", JSON.stringify(r));

await client.end();

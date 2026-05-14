import pg from "pg";
const { Client } = pg;
const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const r1 = await client.query(
  `select trade, name, default_unit_price_ex_gst from shared_materials where name ilike '%HWS%' order by trade, name`,
);
console.log("HOT WATER MATERIALS:");
for (const row of r1.rows) console.log(`  [${row.trade}] $${row.default_unit_price_ex_gst}  ${row.name}`);

const r2 = await client.query(
  `select trade, hourly_rate, default_markup_pct from pricing_book order by trade`,
);
console.log("\nPRICING BOOKS:");
for (const row of r2.rows) console.log(`  [${row.trade}] hourly=$${row.hourly_rate}  markup=${row.default_markup_pct}%`);

const r3 = await client.query(
  `select id, intake_id, needs_inspection, scope_short, scope_of_works
     from quotes
     where share_token = 'XuH597DizYLF9nwBJTDTBw'`,
);
console.log("\nFAILED HOT WATER QUOTE ROW:");
console.log(JSON.stringify(r3.rows[0], null, 2).slice(0, 500));

await client.end();

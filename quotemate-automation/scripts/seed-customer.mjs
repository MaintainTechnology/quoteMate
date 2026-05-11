// Upsert a customers row for SMS-agent memory testing.
// Usage:
//   node --env-file=.env.local scripts/seed-customer.mjs \
//     --phone +61489083371 --first_name Sam --suburb Bondi --address "12 Smith St"

import pg from "pg";

const { Client } = pg;
const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) { console.error("Missing SUPABASE_DB_URL"); process.exit(1); }

function getArg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const phone      = getArg("--phone");
const firstName  = getArg("--first_name");
const suburb     = getArg("--suburb");
const address    = getArg("--address");
const email      = getArg("--email");

if (!phone) { console.error("Need --phone +61XXXXXXXXX"); process.exit(1); }

const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

const res = await client.query(
  `insert into customers (phone_number, first_name, suburb, address, email)
   values ($1, $2, $3, $4, $5)
   on conflict (phone_number) do update set
     first_name = coalesce(excluded.first_name, customers.first_name),
     suburb     = coalesce(excluded.suburb,     customers.suburb),
     address    = coalesce(excluded.address,    customers.address),
     email      = coalesce(excluded.email,      customers.email),
     updated_at = now()
   returning id, phone_number, first_name, suburb, address, email`,
  [phone, firstName, suburb, address, email],
);

console.log("Seeded customer:");
console.log(res.rows[0]);

await client.end();

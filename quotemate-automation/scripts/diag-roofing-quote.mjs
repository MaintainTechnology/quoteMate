// Inspect a saved roofing quote by public_token — per-structure metrics +
// routing reason, to see exactly why a structure was routed to inspection.
// Usage: node --env-file=.env.local scripts/diag-roofing-quote.mjs <token>

import pg from 'pg'

const token = process.argv[2]
if (!token) { console.error('pass a public_token'); process.exit(1) }

const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await c.connect()

const { rows } = await c.query(
  `select address, routing, combined_area_m2, quote from roofing_measurements where public_token = $1`,
  [token],
)
if (rows.length === 0) { console.log('no row for that token'); await c.end(); process.exit(0) }

const row = rows[0]
console.log(`address: ${row.address}`)
console.log(`job routing: ${row.routing} | combined area: ${row.combined_area_m2} m²`)
const q = row.quote
console.log(`inspection_structures: ${JSON.stringify(q?.inspection_structures)}`)
console.log('\n--- per structure ---')
for (const s of q?.structures ?? []) {
  const m = s.metrics ?? {}
  console.log(`\n${s.label} (${s.buildingId})`)
  console.log(`  footprint=${m.footprint_m2}  sloped=${m.sloped_area_m2}  form=${m.form}  storeys=${m.storeys}  hips=${m.hips}  valleys=${m.valleys}`)
  console.log(`  material=${s.inputs?.material}  pitch=${s.inputs?.pitch}  intent=${s.inputs?.intent}`)
  console.log(`  routing=${s.price?.routing?.decision} — ${s.price?.routing?.reason}`)
}

await c.end()

import pg from 'pg'
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } })
await c.connect()
const a = await c.query(`select name, properties, trade, category from shared_materials where category='ev_charger' limit 30`)
console.log('shared_materials ev_charger:', JSON.stringify(a.rows, null, 1))
const b = await c.query(`select name, properties, trade, category from tenant_material_catalogue where category='ev_charger' limit 40`)
console.log('tenant_material_catalogue ev_charger:', JSON.stringify(b.rows, null, 1))
const d = await c.query(`select i.id, i.job_type, i.scope->'specs'->'requested_specs' as rs, q.status, q.risk_flags, q.good->'line_items'->0->>'description' as good0
  from intakes i join quotes q on q.intake_id=i.id where i.job_type='ev_charger' order by q.created_at desc limit 20`)
console.log('recent ev quotes:', JSON.stringify(d.rows, null, 1))
await c.end()

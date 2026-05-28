// One-shot audit script — verify admin_users membership + cross-check the
// jon11e@hotmail.com / tenant 829702af-b7eb-48f6-9574-29bf08ed9106 linkage.
//
// Usage: node --env-file=.env.local scripts/audit-admin-membership.mjs

import pg from 'pg'

const c = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
})
await c.connect()

console.log('\n=== admin_users membership (the allow-list) ===')
const m = await c.query(`
  select au.user_id, au.note, au.created_at, u.email
  from admin_users au
  left join auth.users u on u.id = au.user_id
  order by au.created_at
`)
for (const r of m.rows) {
  console.log(`  ${(r.email ?? '(no-email)').padEnd(40)}  ${r.user_id}  · ${r.note ?? ''}`)
}
console.log(`  (${m.rows.length} admins total)`)

console.log('\n=== Looking up jon11e@hotmail.com ===')
const j = await c.query(`
  select u.id as user_id, u.email,
         t.id as tenant_id, t.business_name,
         (au.user_id is not null) as is_admin
  from auth.users u
  left join tenants t on t.owner_user_id = u.id
  left join admin_users au on au.user_id = u.id
  where lower(u.email) = 'jon11e@hotmail.com'
`)
if (j.rows.length === 0) {
  console.log('  NOT FOUND in auth.users — the email is not registered yet.')
} else {
  for (const r of j.rows) {
    console.log(`  user_id   ${r.user_id}`)
    console.log(`  email     ${r.email}`)
    console.log(`  tenant_id ${r.tenant_id ?? '(no tenant linked)'}`)
    console.log(`  business  ${r.business_name ?? '(n/a)'}`)
    console.log(`  is_admin  ${r.is_admin}`)
  }
}

console.log('\n=== Provided tenant id 829702af-b7eb-48f6-9574-29bf08ed9106 ===')
const t = await c.query(`
  select t.id, t.business_name, t.owner_user_id, u.email
  from tenants t
  left join auth.users u on u.id = t.owner_user_id
  where t.id = '829702af-b7eb-48f6-9574-29bf08ed9106'
`)
if (t.rows.length === 0) {
  console.log('  NOT FOUND in tenants.')
} else {
  for (const r of t.rows) {
    console.log(`  tenant_id     ${r.id}`)
    console.log(`  business      ${r.business_name}`)
    console.log(`  owner_user_id ${r.owner_user_id}`)
    console.log(`  owner_email   ${r.email}`)
  }
}

await c.end()

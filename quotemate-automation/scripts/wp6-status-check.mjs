import pg from "pg";
const c=new pg.Client({connectionString:process.env.SUPABASE_DB_URL,ssl:{rejectUnauthorized:false}});
await c.connect();
const cols=(await c.query(`select column_name from information_schema.columns where table_name='quotes' and column_name in ('price_hold_until','booking_state')`)).rows.map(r=>r.column_name);
console.log("quotes WP6 columns present:", cols.length?cols.join(", "):"(NONE — migration 026 NOT applied)");
const t=(await c.query(`select column_name from information_schema.columns where table_name='tradies' and column_name='available_slots'`)).rows;
console.log("tradies.available_slots column:", t.length?"present":"MISSING");
try{const d=(await c.query(`select count(*)::int n, count(*) filter (where booking_state='reserved')::int reserved, count(*) filter (where booking_state='booked')::int booked, count(*) filter (where price_hold_until is not null)::int held from quotes`)).rows[0];
console.log("quotes:",JSON.stringify(d));}catch(e){console.log("(distribution query failed — columns likely missing:",e.message+")");}
try{const tr=(await c.query(`select id, business_name, coalesce(array_length(available_slots,1),0) n_slots from tradies order by id limit 5`)).rows;
console.log("tradies available_slots:"); tr.forEach(r=>console.log("  "+r.business_name+" -> "+r.n_slots+" slots"));}catch(e){console.log("(tradies query failed:",e.message+")");}
await c.end();

// QuoteMate · audit — product-photo data coverage (preview Item 5)
//
// WHY: the AI preview only attaches a "match this EXACT product" photo
// to Gemini when the quoted line item resolved an image_path from the
// catalogue (lib/ig-engine/product-image.ts + WP4). If catalogue photo
// coverage is low, most quotes fall back to a text-only render → a
// generic-looking product → the "wrong product" failure mode. This
// audit measures whether "wrong product" is a DATA problem (low photo
// coverage) rather than a prompt problem.
//
// READ-ONLY — only SELECT statements, no writes.
//
// Run:  node --env-file=.env.local scripts/audit-product-photo-coverage.mjs
//   (or --env-file=.env.staging.local to audit the staging sandbox)

import pg from 'pg'

const { Client } = pg

const dbUrl = process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('Missing SUPABASE_DB_URL (use --env-file=.env.local)')
  process.exit(1)
}
const target = dbUrl.includes('bobvihqwhtcbxneelfns') ? 'PRODUCTION' : 'staging'

const hasPhoto = (v) => typeof v === 'string' && v.trim() !== ''
const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a')

const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

/** Run a query; on a missing table / column just warn and return null. */
async function safe(label, sql, params = []) {
  try {
    const { rows } = await c.query(sql, params)
    return rows
  } catch (e) {
    console.warn(`  ⚠ ${label} skipped — ${e.message}`)
    return null
  }
}

try {
  await c.connect()
  console.log(`\n══ Product-photo coverage audit · ${target} ══\n`)

  // ── A. tenant_material_catalogue — the table WP4 resolves photos from
  console.log('A. tenant_material_catalogue (per-tenant catalogue)')
  const tmc = await safe(
    'tenant_material_catalogue',
    `select tenant_id,
            count(*)::int                                              as total,
            count(*) filter (where image_path is not null
                               and btrim(image_path) <> '')::int       as with_photo
       from tenant_material_catalogue
      group by tenant_id
      order by total desc`,
  )
  if (tmc) {
    let tAll = 0
    let tPhoto = 0
    for (const r of tmc) {
      tAll += r.total
      tPhoto += r.with_photo
      console.log(
        `   tenant ${String(r.tenant_id ?? 'NULL').slice(0, 8)}  ` +
          `${r.with_photo}/${r.total} have a photo  (${pct(r.with_photo, r.total)})`,
      )
    }
    console.log(
      `   ── TOTAL: ${tPhoto}/${tAll} catalogue products have a photo  (${pct(tPhoto, tAll)})\n`,
    )
  }

  // ── B. supplier_catalogue — the shared catalogue tenant rows copy from
  console.log('B. supplier_catalogue (shared supplier catalogue)')
  const sc = await safe(
    'supplier_catalogue',
    `select count(*)::int                                            as total,
            count(*) filter (where image_path is not null
                              and btrim(image_path) <> '')::int      as with_photo
       from supplier_catalogue`,
  )
  if (sc && sc[0]) {
    console.log(
      `   ${sc[0].with_photo}/${sc[0].total} shared products have a photo  (${pct(sc[0].with_photo, sc[0].total)})\n`,
    )
  }

  // ── C. Quote-weighted hit rate — the rate the preview pipeline ACTUALLY
  //       sees. Scan recent quotes' inline tier line items and count how
  //       many material lines carry an image_path.
  console.log('C. Quote-weighted coverage (last 200 quotes)')
  const quotes = await safe(
    'quotes',
    `select good, better, best
       from quotes
      order by created_at desc
      limit 200`,
  )
  if (quotes) {
    let matLines = 0
    let matWithPhoto = 0
    let quotesAny = 0
    let quotesWithPhoto = 0
    for (const q of quotes) {
      let quoteHasPhoto = false
      let quoteHasMat = false
      for (const tier of [q.good, q.better, q.best]) {
        const items = Array.isArray(tier?.line_items) ? tier.line_items : []
        for (const li of items) {
          const isMaterial =
            !li?.source || String(li.source).startsWith('material')
          if (!isMaterial) continue
          quoteHasMat = true
          matLines++
          if (hasPhoto(li?.image_path)) {
            matWithPhoto++
            quoteHasPhoto = true
          }
        }
      }
      if (quoteHasMat) quotesAny++
      if (quoteHasPhoto) quotesWithPhoto++
    }
    console.log(
      `   material line items with a photo: ${matWithPhoto}/${matLines}  (${pct(matWithPhoto, matLines)})`,
    )
    console.log(
      `   quotes with at least one product photo: ${quotesWithPhoto}/${quotesAny}  (${pct(quotesWithPhoto, quotesAny)})\n`,
    )

    // ── Verdict ───────────────────────────────────────────────────────
    const rate = matLines > 0 ? matWithPhoto / matLines : 0
    console.log('── VERDICT ──')
    if (matLines === 0) {
      console.log('   No material line items found — cannot assess.')
    } else if (rate < 0.5) {
      console.log(
        `   ⚠ LOW coverage (${pct(matWithPhoto, matLines)}). Most quotes render the`,
      )
      console.log(
        '   product from text only → "wrong product" is largely a DATA problem.',
      )
      console.log(
        '   Fix: backfill image_path on tenant_material_catalogue / supplier_catalogue',
      )
      console.log('   before expecting prompt changes to fix product accuracy.')
    } else if (rate < 0.85) {
      console.log(
        `   ~ PARTIAL coverage (${pct(matWithPhoto, matLines)}). Worth backfilling the`,
      )
      console.log('   gap, but prompt + verify-loop work will also help.')
    } else {
      console.log(
        `   ✓ GOOD coverage (${pct(matWithPhoto, matLines)}). "Wrong product" is`,
      )
      console.log('   unlikely to be a data problem — focus on the prompt + verify loop.')
    }
  }
  console.log('')
} catch (e) {
  console.error('Audit failed:', e.message)
  process.exitCode = 1
} finally {
  await c.end()
}

// Coverage for the supplier_catalogue CSV bulk-import parser/validator.
// Both entry points (POST /api/supplier-catalogue/import and the operator
// CLI scripts/import-supplier-catalogue-csv.mjs) route through
// parseSupplierCsv, so these tests are the contract for the CSV format.

import { describe, expect, it } from 'vitest'
import { dedupeKeyFor, parseSupplierCsv, supplierCsvTemplate } from './csv-import'

const HEADER =
  'trade,category,brand,name,default_unit_price_ex_gst,range_series,supplier_label,default_unit,tier_hint,image_url,description'

describe('parseSupplierCsv — happy path', () => {
  it('parses a minimal valid row (required columns only)', () => {
    const csv = `trade,category,brand,name,default_unit_price_ex_gst
electrical,gpo,Clipsal,Clipsal Iconic double GPO,25`
    const res = parseSupplierCsv(csv)
    expect(res.errors).toEqual([])
    expect(res.totalDataRows).toBe(1)
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]).toMatchObject({
      trade: 'electrical',
      category: 'gpo',
      brand: 'Clipsal',
      name: 'Clipsal Iconic double GPO',
      default_unit_price_ex_gst: 25,
      default_unit: 'each',
      range_series: null,
      supplier_label: null,
      tier_hint: null,
      image_url: null,
      description: null,
    })
  })

  it('parses a fully-populated row and normalises values', () => {
    const csv = `${HEADER}
ELECTRICAL,Downlight,SAL,SAL Aniko 9W,"$1,299.50",Aniko,Reece,box,BEST,https://x.com/a.jpg,"Warm white, dimmable"`
    const res = parseSupplierCsv(csv)
    expect(res.errors).toEqual([])
    expect(res.rows[0]).toMatchObject({
      trade: 'electrical', // lower-cased
      category: 'downlight', // lower-cased
      default_unit_price_ex_gst: 1299.5, // $ + thousands separator stripped
      default_unit: 'box',
      tier_hint: 'best', // lower-cased
      description: 'Warm white, dimmable', // quoted comma preserved
    })
  })

  it('rounds price to 2 decimal places', () => {
    const csv = `trade,category,brand,name,default_unit_price_ex_gst
plumbing,tap,Methven,Methven Maku basin mixer,138.999`
    expect(parseSupplierCsv(csv).rows[0].default_unit_price_ex_gst).toBe(139)
  })

  it('tolerates a UTF-8 BOM on the header', () => {
    const csv = `﻿trade,category,brand,name,default_unit_price_ex_gst
plumbing,toilet,Caroma,Caroma Luna suite,389`
    const res = parseSupplierCsv(csv)
    expect(res.errors).toEqual([])
    expect(res.rows).toHaveLength(1)
  })

  it('round-trips its own template with zero errors', () => {
    const res = parseSupplierCsv(supplierCsvTemplate())
    expect(res.errors).toEqual([])
    expect(res.rows).toHaveLength(2)
  })
})

describe('parseSupplierCsv — file-level errors', () => {
  it('flags a missing required column', () => {
    const csv = `trade,brand,name,default_unit_price_ex_gst
electrical,Clipsal,GPO,25`
    const res = parseSupplierCsv(csv)
    expect(res.rows).toHaveLength(0)
    expect(res.errors[0].message).toContain('category')
  })

  it('rejects an upload over the row cap', () => {
    const body = Array.from(
      { length: 2001 },
      (_, i) => `electrical,gpo,Clipsal,GPO ${i},25`,
    ).join('\n')
    const res = parseSupplierCsv(
      `trade,category,brand,name,default_unit_price_ex_gst\n${body}`,
    )
    expect(res.rows).toHaveLength(0)
    expect(res.errors[0].message).toMatch(/too many rows/i)
  })
})

describe('parseSupplierCsv — per-row validation', () => {
  it('rejects an unknown trade', () => {
    const csv = `trade,category,brand,name,default_unit_price_ex_gst
carpentry,gpo,Clipsal,GPO,25`
    const res = parseSupplierCsv(csv)
    expect(res.rows).toHaveLength(0)
    expect(res.errors[0]).toMatchObject({ line: 2, column: 'trade' })
  })

  it('rejects an unknown category', () => {
    const csv = `trade,category,brand,name,default_unit_price_ex_gst
electrical,teleporter,Clipsal,GPO,25`
    const res = parseSupplierCsv(csv)
    expect(res.rows).toHaveLength(0)
    expect(res.errors[0].column).toBe('category')
  })

  it.each([
    ['not-a-number', 'abc'],
    ['zero', '0'],
    ['negative', '-5'],
  ])('rejects an invalid price (%s)', (_label, price) => {
    const csv = `trade,category,brand,name,default_unit_price_ex_gst
electrical,gpo,Clipsal,GPO,${price}`
    const res = parseSupplierCsv(csv)
    expect(res.rows).toHaveLength(0)
    expect(res.errors[0].column).toBe('default_unit_price_ex_gst')
  })

  it('rejects an invalid tier_hint but allows a blank one', () => {
    const bad = `${HEADER}
electrical,gpo,Clipsal,GPO,25,,,,platinum,,`
    expect(parseSupplierCsv(bad).errors[0].column).toBe('tier_hint')

    const blank = `${HEADER}
electrical,gpo,Clipsal,GPO,25,,,,,,`
    const res = parseSupplierCsv(blank)
    expect(res.errors).toEqual([])
    expect(res.rows[0].tier_hint).toBeNull()
  })

  it('rejects an image_url without an http(s) scheme', () => {
    const csv = `${HEADER}
electrical,gpo,Clipsal,GPO,25,,,,,ftp://x.com/a.jpg,`
    expect(parseSupplierCsv(csv).errors[0].column).toBe('image_url')
  })

  it('keeps valid rows and isolates invalid ones', () => {
    const csv = `trade,category,brand,name,default_unit_price_ex_gst
electrical,gpo,Clipsal,Good Row,25
electrical,gpo,Clipsal,Bad Row,-1
plumbing,tap,Methven,Another Good Row,99`
    const res = parseSupplierCsv(csv)
    expect(res.totalDataRows).toBe(3)
    expect(res.rows.map((r) => r.name)).toEqual(['Good Row', 'Another Good Row'])
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].line).toBe(3)
  })

  it('flags a duplicate (trade+brand+name) within the same file', () => {
    const csv = `trade,category,brand,name,default_unit_price_ex_gst
electrical,gpo,Clipsal,Iconic GPO,25
electrical,gpo,Clipsal,iconic gpo,30`
    const res = parseSupplierCsv(csv)
    expect(res.rows).toHaveLength(1) // first row kept
    expect(res.errors[0]).toMatchObject({ line: 3, column: 'name' })
  })
})

describe('parseSupplierCsv — allowedTrades scoping', () => {
  it('rejects rows outside the caller-permitted trades', () => {
    const csv = `trade,category,brand,name,default_unit_price_ex_gst
electrical,gpo,Clipsal,GPO,25
plumbing,tap,Methven,Mixer,99`
    const res = parseSupplierCsv(csv, { allowedTrades: ['electrical'] })
    expect(res.rows.map((r) => r.trade)).toEqual(['electrical'])
    expect(res.errors[0]).toMatchObject({ line: 3, column: 'trade' })
  })
})

describe('dedupeKeyFor', () => {
  it('is case- and whitespace-insensitive (matches the unique index)', () => {
    expect(dedupeKeyFor('Electrical', 'Clipsal', '  Iconic GPO ')).toBe(
      dedupeKeyFor('electrical', 'CLIPSAL', 'iconic gpo'),
    )
  })
})

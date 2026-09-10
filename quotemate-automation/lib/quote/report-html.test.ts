// Unit tests for the customer quote PDF HTML (migration 105) — tier
// rendering, inc-GST rounding parity with the SMS template, escaping.

import { describe, it, expect } from 'vitest'
import {
  buildQuoteReportHtml,
  buildQuoteReportHtmlFromBody,
  incGst,
  REPORT_TEMPLATE_VERSION,
  type QuoteReportTier,
} from './report-html'
import { resolveVisibleTiers, type QuoteTierMode } from './tier-visibility'
import { TRADIE_AVATAR_PLACEHOLDER } from './tradie-profile'

const tier = (label: string, exGst: number): QuoteReportTier => ({
  label,
  subtotal_ex_gst: exGst,
  line_items: [
    { description: 'LED downlight 9W', quantity: 6, unit: 'each', unit_price_ex_gst: 28, total_ex_gst: 168 },
    { description: 'Install labour', quantity: 3, unit: 'hr', unit_price_ex_gst: 110, total_ex_gst: 330 },
  ],
})

describe('incGst', () => {
  it('matches the SMS template rounding (Math.round(ex * 1.1))', () => {
    expect(incGst(498)).toBe(548)
    expect(incGst('100')).toBe(110)
    expect(incGst('not-a-number')).toBe(0)
  })
})

describe('report date (RC-9 — the live preview and the cached PDF print the SAME date)', () => {
  // Both surfaces are built from buildQuoteReportInput, which now feeds the
  // persisted created_at as generatedAt. The report must honour that input
  // rather than stamping a fresh new Date() per render — otherwise the always-
  // live HTML preview and a PDF cached on an earlier day disagree across midnight
  // (a real "the PDFs differ slightly" symptom). Local-time Date so the assert is
  // timezone-stable (the server renders both surfaces in one timezone).
  const base = {
    businessName: 'Acme Electrical',
    jobType: 'downlights',
    good: null,
    better: tier('Recommended', 500),
    best: null,
  }

  it('prints the supplied generatedAt, not the wall-clock day', () => {
    const html = buildQuoteReportHtml({ ...base, generatedAt: new Date(2020, 0, 15) })
    expect(html).toContain('15 January 2020')
  })

  it('is deterministic — the same quote always prints the same date on every channel', () => {
    const d = new Date(2021, 5, 30)
    expect(buildQuoteReportHtml({ ...base, generatedAt: d })).toBe(
      buildQuoteReportHtml({ ...base, generatedAt: d }),
    )
  })
})

describe('buildQuoteReportHtml — roofing layout overlay', () => {
  const base = {
    businessName: 'Pilot Roofer',
    jobType: 'full_reroof',
    good: tier('Patch', 1000),
    better: tier('Re-roof', 2500),
    best: tier('Upgrade', 4000),
    selectedTier: 'better' as const,
    quoteViewUrl: 'https://example.com/q/tok',
  }

  it('renders the roof layout map + estimated materials when an overlay is supplied', () => {
    const html = buildQuoteReportHtml({
      ...base,
      layoutOverlay: {
        header: "G'day! Here is your re-roofing plan.",
        aerialSrc: 'data:image/png;base64,AAAA',
        overlaySrc: 'data:image/svg+xml;base64,BBBB',
        legend: [{ color: 'teal', label: 'Full re-sheeting of main dwelling' }],
        materials: {
          items: [
            { item: 'Colorbond corrugated sheets', qty: 154, unit: 'sheets', basis: '586 m² ÷ 4.19 m² per sheet', use: 'New roof sheeting.' },
          ],
          note: null,
        },
      },
    })
    expect(html).toContain('Your roof layout map')
    expect(html).toContain('Estimated materials')
    expect(html).toContain('Full re-sheeting of main dwelling')
    expect(html).toContain('Colorbond corrugated sheets')
    expect(html).toContain('154 sheets')
  })

  it('omits the layout section entirely when no overlay is supplied (every other trade)', () => {
    const html = buildQuoteReportHtml(base)
    expect(html).not.toContain('Your roof layout map')
    expect(html).not.toContain('Estimated materials')
  })
})

describe('buildQuoteReportHtml', () => {
  const html = buildQuoteReportHtml({
    businessName: 'Pilot Sparky',
    customerName: 'Sam Smith',
    jobType: 'downlights',
    scopeOfWorks: 'Replace 6 existing downlights with new LEDs.',
    assumptions: ['Accessible ceiling space', 'Existing wiring serviceable'],
    estimatedTimeframe: 'half a day',
    good: tier('Budget LEDs', 498),
    better: tier('Mid-range LEDs', 598),
    best: tier('Premium LEDs <Clipsal>', 698),
    selectedTier: 'better',
    quoteViewUrl: 'https://example.com/q/tok123',
  })

  it('renders every tier with inc-GST headline prices', () => {
    expect(html).toContain('GOOD')
    expect(html).toContain('BETTER · RECOMMENDED')
    expect(html).toContain('BEST')
    expect(html).toContain('$547.80')
    expect(html).toContain('$657.80')
    expect(html).toContain('$767.80')
  })

  it('renders line items, scope, assumptions, and the view link', () => {
    expect(html).toContain('LED downlight 9W')
    expect(html).toContain('Replace 6 existing downlights')
    expect(html).toContain('Accessible ceiling space')
    expect(html).toContain('https://example.com/q/tok123')
    expect(html).toContain('Sam Smith')
    expect(html).toContain('Pilot Sparky')
  })

  it('escapes HTML in user-influenced strings', () => {
    expect(html).toContain('Premium LEDs &lt;Clipsal&gt;')
    expect(html).not.toContain('<Clipsal>')
  })

  it('drops missing tiers instead of rendering empty sections', () => {
    const single = buildQuoteReportHtml({
      businessName: 'Pilot Plumber',
      jobType: 'hot_water',
      good: tier('Replace like-for-like', 1400),
      better: null,
      best: null,
    })
    expect(single).toContain('GOOD')
    expect(single).not.toContain('BETTER')
    expect(single).not.toContain('BEST')
    expect(single).toContain('hot water')
  })
})

// Spec quote-pdf-logo-fix — the electrical/plumbing builder must surface the
// tenant logo (it flows branding → renderReportDocument) and fall back to the
// business-name wordmark when no logo is configured, without throwing.
describe('buildQuoteReportHtml — tenant logo (electrical/plumbing)', () => {
  it('renders the tenant logo when branding.logoSrc is set', () => {
    const html = buildQuoteReportHtml({
      businessName: 'Atomic Electrical',
      branding: { businessName: 'Atomic Electrical', logoSrc: 'data:image/png;base64,BBBB' },
      jobType: 'downlights',
      good: tier('Budget', 498),
      better: null,
      best: null,
    })
    expect(html).toContain('class="logo"')
    expect(html).toContain('data:image/png;base64,BBBB')
    expect(html).not.toContain('class="wordmark"')
  })

  it('falls back to the business-name wordmark when no logo is set', () => {
    const html = buildQuoteReportHtml({
      businessName: 'Oakcrest Electrical',
      jobType: 'downlights',
      good: tier('Budget', 498),
      better: null,
      best: null,
    })
    expect(html).toContain('class="wordmark"')
    expect(html).toContain('Oakcrest Electrical')
    expect(html).not.toContain('class="logo"')
  })
})

// Mig 146 — the eyebrow / intro / heading wording follows the number of VISIBLE
// tiers (the PDF service has already filtered good/better/best to the tenant's
// Pricing-settings tier mode). One tier reads as a single quote with NO
// "Good / Better / Best"; two or more keeps the tiered framing.
describe('buildQuoteReportHtml — tier-count-aware wording (mig 146)', () => {
  it('a single visible tier drops all "Good / Better / Best" wording', () => {
    const html = buildQuoteReportHtml({
      businessName: 'Oakcrest Electrical',
      jobType: 'downlights',
      good: tier('Standard LED', 558),
      better: null,
      best: null,
    })
    // Headline still shows the one priced tier...
    expect(html).toContain('GOOD')
    // ...but none of the multi-tier framing.
    expect(html).not.toContain('Good / Better / Best')
    expect(html).toContain('<h2>Your quote</h2>')
    expect(html).not.toContain('<h2>Your options</h2>')
  })

  it('two or more visible tiers keep the Good / Better / Best framing', () => {
    const html = buildQuoteReportHtml({
      businessName: 'Oakcrest Electrical',
      jobType: 'downlights',
      good: tier('Standard LED', 558),
      better: tier('Tri-colour LED', 720),
      best: null,
      selectedTier: 'better',
    })
    expect(html).toContain('Good / Better / Best')
    expect(html).toContain('<h2>Your options</h2>')
    expect(html).not.toContain('<h2>Your quote</h2>')
  })
})

// Mig 146 — the PDF must render EXACTLY the tiers the tenant's mode resolves to.
// This mirrors how lib/quote/pdf.ts filters good/better/best by
// resolveVisibleTiers before calling the builder, across every tier mode.
describe('buildQuoteReportHtml — renders exactly resolveVisibleTiers(...) (mig 146)', () => {
  const priced = {
    good: tier('Standard', 600),
    better: tier('Mid', 800),
    best: tier('Premium', 1100),
  }
  const present = { good: true, better: true, best: true }
  const cases: Array<{
    mode: QuoteTierMode
    selected: 'good' | 'better' | 'best'
    show: string[]
    hide: string[]
  }> = [
    { mode: 'single', selected: 'better', show: ['BETTER'], hide: ['GOOD', 'BEST'] },
    { mode: 'good', selected: 'better', show: ['GOOD'], hide: ['BETTER', 'BEST'] },
    { mode: 'best', selected: 'better', show: ['BEST'], hide: ['GOOD', 'BETTER'] },
    { mode: 'good_better_best', selected: 'better', show: ['GOOD', 'BETTER', 'BEST'], hide: [] },
  ]
  for (const c of cases) {
    it(`mode '${c.mode}' renders exactly ${JSON.stringify(c.show)}`, () => {
      const keys = resolveVisibleTiers({ mode: c.mode, present, selectedTier: c.selected })
      const set = new Set(keys)
      const html = buildQuoteReportHtml({
        businessName: 'T',
        jobType: 'downlights',
        good: set.has('good') ? priced.good : null,
        better: set.has('better') ? priced.better : null,
        best: set.has('best') ? priced.best : null,
        selectedTier: keys.length > 1 ? c.selected : null,
      })
      for (const marker of c.show) expect(html).toContain(marker)
      for (const marker of c.hide) expect(html).not.toContain(marker)
    })
  }
})

// Spec specs/quote-visual-parity.md R1 — the property-visuals section brings
// the customer page's satellite image + measurement stat grid into the same
// report the PDF and the dashboard live preview render from.
describe('buildQuoteReportHtml — propertyVisuals (spec quote-visual-parity R1)', () => {
  const base = {
    businessName: 'Atomic Roofing',
    jobType: 'full_reroof',
    scopeOfWorks: 'Re-roof priced across 1 structure.',
    good: null,
    better: tier('Re-roof, all structures', 29055),
    best: null,
  }
  const visuals = {
    imageSrc: 'data:image/png;base64,AAAA',
    caption: 'Your roof, from above · Google Maps',
    stats: [
      { label: 'Sloped area', value: '194 m²' },
      { label: 'Material', value: 'Colorbond <Corrugated>' },
    ],
    disclaimer:
      'The numbers are calculated from satellite imagery — your final price is locked after our on-site inspection.',
  }

  it('renders the image, caption, stats and disclaimer when provided', () => {
    const html = buildQuoteReportHtml({ ...base, propertyVisuals: visuals })
    expect(html).toContain('data:image/png;base64,AAAA')
    expect(html).toContain('Your roof, from above')
    expect(html).toContain('Sloped area')
    expect(html).toContain('194 m²')
    expect(html).toContain('locked after our on-site inspection')
  })

  it('places the section between the scope of works and the tiers', () => {
    const html = buildQuoteReportHtml({ ...base, propertyVisuals: visuals })
    const scopeAt = html.indexOf('Re-roof priced across 1 structure.')
    const visualsAt = html.indexOf('Your roof, from above')
    const tierAt = html.indexOf('BETTER')
    expect(scopeAt).toBeGreaterThan(-1)
    expect(visualsAt).toBeGreaterThan(scopeAt)
    expect(tierAt).toBeGreaterThan(visualsAt)
  })

  it('renders stats-only (no <img>) when imageSrc is null', () => {
    const html = buildQuoteReportHtml({
      ...base,
      propertyVisuals: { ...visuals, imageSrc: null },
    })
    expect(html).toContain('Sloped area')
    expect(html).not.toContain('data:image/png;base64,AAAA')
  })

  it('escapes HTML in stat values and caption', () => {
    const html = buildQuoteReportHtml({ ...base, propertyVisuals: visuals })
    expect(html).toContain('Colorbond &lt;Corrugated&gt;')
    expect(html).not.toContain('<Corrugated>')
  })

  it('body is identical to today when propertyVisuals is null or omitted', () => {
    const omitted = buildQuoteReportHtml(base)
    const explicitNull = buildQuoteReportHtml({ ...base, propertyVisuals: null })
    expect(explicitNull).toBe(omitted)
    expect(omitted).not.toContain('Your roof, from above')
  })

  it('REPORT_TEMPLATE_VERSION refreshes cached PDFs for saved appearance after the tax repair', () => {
    expect(REPORT_TEMPLATE_VERSION).toBe(11)
  })

  it('v7 — tier prices honour the realised early-booking discount (P7)', () => {
    const discounted = buildQuoteReportHtml({
      businessName: 'Pilot Sparky',
      jobType: 'downlights',
      good: null,
      better: tier('Mid-range LEDs', 1000),
      best: null,
      selectedTier: null,
      appliedDiscountPct: 10,
    })
    // 1000 ex · 10% off → 900 ex → $990 inc, flagged as discounted.
    expect(discounted).toContain('$990')
    expect(discounted).toContain('10% off applied')
    expect(discounted).not.toContain('$1,100')
  })

  it('v7 — a non-GST-registered tradie renders ex-GST headline prices (P1)', () => {
    const noGst = buildQuoteReportHtml({
      businessName: 'Pilot Sparky',
      jobType: 'downlights',
      good: null,
      better: tier('Mid-range LEDs', 1000),
      best: null,
      selectedTier: null,
      gstRegistered: false,
    })
    expect(noGst).toContain('$1,000')
    expect(noGst).not.toContain('$1,100')
  })

  it('chunks a full 8-stat roofing grid into rows of 4 (the chrome statgrid does not wrap)', () => {
    const eightStats = [
      'Sloped area', 'Material', 'Roof form', 'Pitch',
      'Hips · valleys', 'Ridge', 'Storeys', 'Footprint',
    ].map((label, i) => ({ label, value: `v${i}` }))
    const html = buildQuoteReportHtml({
      ...base,
      propertyVisuals: { ...visuals, stats: eightStats },
    })
    const grids = html.match(/<div class="statgrid">/g) ?? []
    expect(grids.length).toBe(2)
    // 4 or fewer stats stay in a single grid.
    const small = buildQuoteReportHtml({
      ...base,
      propertyVisuals: { ...visuals, stats: eightStats.slice(0, 4) },
    })
    expect((small.match(/<div class="statgrid">/g) ?? []).length).toBe(1)
  })
})

describe('buildQuoteReportHtmlFromBody', () => {
  const base = {
    businessName: 'Acme Electrical',
    jobType: 'downlights',
    good: { label: 'Good', subtotal_ex_gst: 1000, line_items: [] } as QuoteReportTier,
    better: null,
    best: null,
    selectedTier: null,
  }

  it('renders the supplied body verbatim inside the report chrome', () => {
    const html = buildQuoteReportHtmlFromBody(base, '<h2>Custom body</h2><p>Hello world body</p>')
    expect(html).toContain('<h2>Custom body</h2><p>Hello world body</p>')
    expect(html).toContain('Acme Electrical') // chrome (branding) still present
  })

  it('substitutes the body without leaking the default scope/tier markup', () => {
    // A custom body must NOT also emit the default "Your quote" tier section.
    const html = buildQuoteReportHtmlFromBody(base, '<p>Only this</p>')
    expect(html).toContain('<p>Only this</p>')
    expect(html).not.toContain('>GOOD<')
  })

  it('buildQuoteReportHtml (default body) still renders the tier + chrome', () => {
    // The refactor is output-identical for the default path — the pre-existing
    // suite above already asserts the exact markup; this is a belt-and-braces smoke.
    const html = buildQuoteReportHtml(base)
    expect(html).toContain('Acme Electrical')
    expect(html).toContain('GOOD')
    expect(html).toContain('Your quote')
  })
})

// ─── Job details + Your tradie (customer-view parity) ───────────────
//
// The web customer view renders five numbered sections; sections 02 "Job
// details" and 03 "Your tradie" existed ONLY on the page — the downloadable
// PDF showed neither. These assert the PDF now carries both, from the same
// data (quotes.scope_short + tenants.photo_url).
const parityBase = {
  businessName: 'Atomic Electrical',
  jobType: 'reroof',
  good: null,
  better: { label: 'Full roof replacement', subtotal_ex_gst: 66838 } as QuoteReportTier,
  best: null,
  selectedTier: null,
}

describe('job details section (parity with customer-view section 02)', () => {
  it('renders the scope_short sentence under a "Job details" heading', () => {
    const html = buildQuoteReportHtml({
      ...parityBase,
      jobDetails: 'Re-roof priced across 1 structure.',
    })
    expect(html).toContain('<h2>Job details</h2>')
    expect(html).toContain('Re-roof priced across 1 structure.')
  })

  it('omits the section entirely when the quote has no scope_short', () => {
    expect(buildQuoteReportHtml(parityBase)).not.toContain('Job details')
    expect(buildQuoteReportHtml({ ...parityBase, jobDetails: '   ' })).not.toContain('Job details')
  })

  it('escapes the job-details text', () => {
    const html = buildQuoteReportHtml({
      ...parityBase,
      jobDetails: 'Re-roof <script>x</script> & more',
    })
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>x</script>')
  })

  it('places job details after the scope of works and before the price', () => {
    const html = buildQuoteReportHtml({
      ...parityBase,
      scopeOfWorks: 'Roofing works at 670 London Road.',
      jobDetails: 'Re-roof priced across 1 structure.',
    })
    // Match the headings, not the prose — the chrome's intro paragraph also
    // says "Your quote is set out below" well above the body.
    expect(html.indexOf('<h2>Scope of works</h2>')).toBeLessThan(
      html.indexOf('<h2>Job details</h2>'),
    )
    expect(html.indexOf('<h2>Job details</h2>')).toBeLessThan(html.indexOf('<h2>Your quote</h2>'))
  })
})

describe('your tradie section (parity with customer-view section 03)', () => {
  it('renders the tradie photo and blurb under a "Your tradie" heading', () => {
    const html = buildQuoteReportHtml({
      ...parityBase,
      tradie: {
        name: 'Atomic Electrical',
        photoSrc: 'data:image/jpeg;base64,AAAA',
        hasPhoto: true,
        blurb: 'Atomic Electrical is a licensed local roofing business.',
      },
    })
    expect(html).toContain('<h2>Your tradie</h2>')
    expect(html).toContain('src="data:image/jpeg;base64,AAAA"')
    expect(html).toContain('Atomic Electrical is a licensed local roofing business.')
  })

  it('still renders the block with the placeholder avatar when no photo is set', () => {
    const html = buildQuoteReportHtml({
      ...parityBase,
      tradie: {
        name: 'Atomic Electrical',
        photoSrc: TRADIE_AVATAR_PLACEHOLDER,
        hasPhoto: false,
        blurb: 'Atomic Electrical is a licensed local roofing business.',
      },
    })
    expect(html).toContain('<h2>Your tradie</h2>')
    expect(html).toContain('data:image/svg+xml')
  })

  it('omits the section when no tradie profile is supplied (back-compat)', () => {
    const html = buildQuoteReportHtml(parityBase)
    expect(html).not.toContain('<h2>Your tradie</h2>')
    expect(html).not.toContain('class="tradie"')
  })

  it('escapes the tradie name and blurb', () => {
    const html = buildQuoteReportHtml({
      ...parityBase,
      tradie: {
        name: 'A & B <Roofing>',
        photoSrc: TRADIE_AVATAR_PLACEHOLDER,
        hasPhoto: false,
        blurb: 'A & B <Roofing> is a licensed local roofing business.',
      },
    })
    expect(html).toContain('A &amp; B &lt;Roofing&gt;')
    expect(html).not.toContain('<Roofing>')
  })
})

describe('REPORT_TEMPLATE_VERSION', () => {
  it('is bumped past v7 so cached PDFs regenerate with the new sections', () => {
    expect(REPORT_TEMPLATE_VERSION).toBeGreaterThanOrEqual(8)
  })
})

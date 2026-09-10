// ════════════════════════════════════════════════════════════════════
// Shared white-label PDF "chrome" for every trade's customer quote.
//
// One premium document shell — branded header (tenant logo, falling back
// to the business name), a thank-you intro, the body slot (each trade's
// own content), a "Please Note" block and a repeating footer — rendered
// by Gotenberg (lib/pdf/gotenberg.ts) as ONE continuous page (A4 width,
// content-derived height). The body width is pinned to the printable width;
// that is load-bearing, not cosmetic — see gotenberg.ts.
//
// Design system: the LIVE Caterpillar palette in app/globals.css, LIGHT
// "warm paper" variant (locked — spec specs/quote-pdf-branding.md D3).
// Caterpillar yellow #FFC400 is used only as FILLS with dark ink on it,
// never as text colour on the cream page (yellow text fails WCAG).
//
// White-label: NO "QuoteMax" string or mark appears here.
// Pure & deterministic (pass `generatedAt`); unit-tested.
// ════════════════════════════════════════════════════════════════════

import { PDF_CONTENT_WIDTH_IN } from './gotenberg'
import { businessInitials } from '@/lib/brand/monogram'
import { reportAppearanceCss } from '@/lib/quote/report-doc/appearance'
import type { ReportStyle } from '@/lib/quote/report-doc/style'

/** HTML-escape a user-influenced string. Shared by every trade builder. */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** "$1,234" — whole-dollar AU. */
export const aud0 = (n: number): string => '$' + Math.round(n).toLocaleString('en-AU')

/** "$1,234.00" — two-dp AU (line items). */
export const aud2 = (n: number): string =>
  '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Locked Caterpillar accent (light warm-paper variant). */
export const ACCENT = '#FFC400'
export const ACCENT_INK = '#2B2422'

/**
 * The tenant's white-label identity. Every field except `businessName` is
 * optional and is gracefully omitted when null (spec R2/R15). Built by
 * lib/pdf/branding.ts from existing `tenants` / `tenant_licences` columns.
 */
export type TenantBranding = {
  businessName: string
  /** data: URI (preferred) or absolute URL for the tenant logo <img>. */
  logoSrc?: string | null
  tagline?: string | null
  /** Legal entity line, e.g. "ACME ROOFING PTY LTD ABN 97 131 182 093". */
  legalLine?: string | null
  /** Contact line, e.g. "Tel 1300 734 148 · jobs@acme.com.au". */
  contactLine?: string | null
  /** Website, e.g. "www.acmeroofing.com.au". */
  website?: string | null
  /** Postal / business address. */
  address?: string | null
  /** Regulatory footer line, e.g. "QBCC Lic. 1147373 · ABN 97 131 182 093". */
  licenceLine?: string | null
}

/** Build a minimal branding object from just a business name (test/back-compat). */
export function brandingFromName(businessName: string): TenantBranding {
  return { businessName }
}

/** The trade-agnostic document content the chrome wraps around. */
export type ReportDocument = {
  /** Optional bounded per-quote appearance; absent preserves the shared defaults. */
  appearance?: ReportStyle | null
  /** <title> — white-label, no QuoteMax. */
  docTitle: string
  /** Mono eyebrow above the heading, e.g. "Roofing quote · Good / Better / Best". */
  eyebrow?: string | null
  /** The big visible title above the intro meta. Defaults to "Quotation" — the
   *  string every trade printed before this slot existed, so an omitting caller
   *  renders byte-identically. The EV charger estimate passes "ESTIMATE"
   *  (spec ev-charger-estimate-template R2). */
  titleText?: string | null
  /** Replaces the flat "Name · Date · Contact" sub-line with caller-supplied
   *  HTML (already escaped by the caller). Absent ⇒ the default sub-line, so
   *  existing callers are unchanged. The EV estimate passes a two-column
   *  Prepared For / Proposal Details block (spec R2/R3). */
  introMetaHtml?: string | null
  /** Pre-formatted date string (caller controls locale/format). */
  dateLabel: string
  customerName?: string | null
  /** Site / job address shown in the intro block. */
  siteAddress?: string | null
  /** Customer's own contact (email / phone), when known. */
  customerContact?: string | null
  /** Thank-you / intro paragraph HTML (already escaped/built by the trade). */
  introHtml?: string | null
  /** The trade-native body HTML (already escaped/built by the trade). */
  bodyHtml: string
  /** "Please Note" disclaimer bullets (plain text — escaped here). */
  pleaseNote?: string[] | null
  /** Closing line under the body, e.g. a live-quote URL note (plain text). */
  closingLine?: string | null
  /** Point-of-use GST basis for the repeating footer. */
  footerPriceNote?: string | null
  /**
   * Replace the accent rule + `.intro-block` (eyebrow / title / intro meta)
   * with the trade's own markup. Already-built HTML.
   *
   * Exists for the EV charger estimate's banded direction, whose summary band
   * is FULL-BLEED: it carries its own 30px insets and must reach the document
   * edges, which a block nested inside `.intro-block` cannot do. Suppressing
   * the default by passing empty slots is not possible — `titleText` falls back
   * to "Quotation" — so the replacement has to be explicit.
   *
   * Omit it and every other trade renders exactly as before.
   */
  introBlockHtml?: string | null
  /**
   * Replace the `<p class="closing">` line with the trade's own markup — same
   * full-bleed reasoning as `introBlockHtml` (the EV accept band). When set,
   * `closingLine` is ignored.
   */
  closingHtml?: string | null
}

function wordmark(b: TenantBranding): string {
  // Logo when we have one; otherwise the business name set as the wordmark
  // (spec R2 fallback). The <img> is height-capped so oversized uploads
  // can't blow out the header; object-fit keeps the aspect ratio.
  if (b.logoSrc) {
    return `<img class="logo" src="${esc(b.logoSrc)}" alt="${esc(b.businessName)}">`
  }
  // No logo — the initials monogram leads the wordmark, matching the mark the
  // HTML letterhead draws for the same tenant. The name still prints: unlike
  // the letterhead, this header has no separate business-name line.
  const initials = businessInitials(b.businessName)
  const mark = initials ? `<span class="monogram">${esc(initials)}</span>` : ''
  return `${mark}<div class="wordmark">${esc(b.businessName)}</div>`
}

/** Render one bulleted scope list (shared visual vocabulary across trades). */
export function renderBullets(items: string[]): string {
  const clean = items.map((s) => s?.trim()).filter(Boolean) as string[]
  if (clean.length === 0) return ''
  return `<ul class="bullets">${clean.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
}

/**
 * The signature "Part" card — a big mono marker in a yellow tile, an
 * uppercase title, an optional scope note, bulleted scope of works and
 * optional priced line rows. Used by roofing (Part A/B/C…) and available
 * to any trade that wants the lettered-section look.
 */
export function renderPart(opts: {
  marker: string
  title: string
  note?: string | null
  bullets?: string[]
  priceLines?: string[] // pre-built HTML strings (may contain <span> emphasis)
  /** Raw HTML appended inside the card — figures, the tradie block, price rows. */
  html?: string
  optional?: boolean
}): string {
  const noteHtml = opts.note ? `<span class="part-note">${esc(opts.note)}</span>` : ''
  const bulletsHtml = opts.bullets ? renderBullets(opts.bullets) : ''
  const priceHtml =
    opts.priceLines && opts.priceLines.length
      ? `<ol class="prices">${opts.priceLines.map((p) => `<li>${p}</li>`).join('')}</ol>`
      : ''
  return `
  <section class="part">
    <div class="part-head">
      <span class="marker">${esc(opts.marker)}</span>
      <h2 class="part-title">${esc(opts.title)}${
        opts.optional ? ' <span class="chip">Optional</span>' : ''
      }</h2>
    </div>
    ${noteHtml ? `<p class="part-note-row">${noteHtml}</p>` : ''}
    ${bulletsHtml}
    ${priceHtml}
    ${opts.html ?? ''}
  </section>`
}

/**
 * The "Your tradie" identity block — the tradie's photo (or the placeholder
 * avatar) beside the licensed-local-business sentence, as resolved by
 * lib/quote/tradie-profile.ts. Lives here, next to its `.tradie` CSS, so the
 * generic quote report and every trade-native one render section 03 identically.
 */
export function renderTradieBlock(
  t: { name: string; photoSrc: string; blurb: string } | null | undefined,
): string {
  if (!t) return ''
  return `
  <div class="tradie">
    <img class="tradie-photo" src="${esc(t.photoSrc)}" alt="${esc(t.name)}">
    <div class="tradie-copy">
      <div class="tradie-name">${esc(t.name)}</div>
      <p class="note">${esc(t.blurb)}</p>
    </div>
  </div>`
}

/** A captioned image figure. Returns '' when there's no src (spec R6/edge). */
export function renderFigure(src: string | null | undefined, caption?: string | null): string {
  if (!src) return ''
  return `
  <figure class="figure">
    <img src="${esc(src)}" alt="${esc(caption ?? 'Quote image')}">
    ${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}
  </figure>`
}

/**
 * A two-image figure: a hero image plus a smaller secondary thumbnail (e.g. the
 * roof outline tracing as the hero with a small aerial reference beneath it —
 * spec roof-pdf-outline-tracing R6/R8). Falls back to a single captioned figure
 * when only one source is present, and '' when neither is.
 */
export function renderFigurePair(opts: {
  heroSrc?: string | null
  heroCaption?: string | null
  thumbSrc?: string | null
  thumbCaption?: string | null
}): string {
  const { heroSrc, heroCaption, thumbSrc, thumbCaption } = opts
  if (!heroSrc && !thumbSrc) return ''
  if (heroSrc && !thumbSrc) return renderFigure(heroSrc, heroCaption)
  if (!heroSrc && thumbSrc) return renderFigure(thumbSrc, thumbCaption)
  return `
  <figure class="figure figure-pair">
    <img class="hero" src="${esc(heroSrc!)}" alt="${esc(heroCaption ?? 'Roof outline')}">
    ${heroCaption ? `<figcaption>${esc(heroCaption)}</figcaption>` : ''}
    <div class="thumb">
      <img src="${esc(thumbSrc!)}" alt="${esc(thumbCaption ?? 'Aerial reference')}">
      ${thumbCaption ? `<figcaption>${esc(thumbCaption)}</figcaption>` : ''}
    </div>
  </figure>`
}

/**
 * The whole document. Composes the white-label header, intro, body slot,
 * "Please Note" and the repeating footer into a single print-safe A4 HTML
 * string. The trade builders only assemble `bodyHtml` + slots.
 */
export function renderReportDocument(branding: TenantBranding, doc: ReportDocument): string {
  const pleaseNote = (doc.pleaseNote ?? []).map((s) => s?.trim()).filter(Boolean) as string[]

  const headerMeta = [
    branding.tagline ? `<div class="tagline">${esc(branding.tagline)}</div>` : '',
    branding.legalLine ? `<div class="legal">${esc(branding.legalLine)}</div>` : '',
    branding.contactLine ? `<div class="contact">${esc(branding.contactLine)}</div>` : '',
    branding.website ? `<div class="contact">${esc(branding.website)}</div>` : '',
    branding.address ? `<div class="contact">${esc(branding.address)}</div>` : '',
  ]
    .filter(Boolean)
    .join('')

  const introCustomer = [
    doc.customerName ? esc(doc.customerName) : '',
    doc.siteAddress ? esc(doc.siteAddress) : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<title>${esc(doc.docTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
  /* ── Caterpillar light "warm paper" tokens (app/globals.css light theme) ── */
  :root{
    --paper:#FAF8F4; --card:#FFFFFF; --line:#E9E3DC;
    --accent:${ACCENT}; --accent-ink:${ACCENT_INK};
    --pri:#241E1B; --sec:#5E544E; --dim:#837870;
  }
  *{ box-sizing:border-box; }
  html,body{ background:var(--paper); }
  body{
    margin:0 auto; color:var(--pri);
    font-family:'Manrope','Segoe UI',-apple-system,system-ui,Arial,sans-serif;
    font-size:12px; line-height:1.55;
    /* Pin the layout width to the printable width. Gotenberg renders this
       document as ONE continuous page, and it derives that page's height by
       measuring the document at the browser viewport width — so the width
       must not depend on the viewport, or the tail gets clipped. See the
       SINGLE-PAGE / WIDTH CONTRACT in lib/pdf/gotenberg.ts. */
    width:${PDF_CONTENT_WIDTH_IN}in;
    /* reserve room for the repeating fixed footer so content never overlaps */
    padding-bottom:64px;
  }
  .mono{ font-family:'JetBrains Mono','Courier New',monospace; }

  /* ── Header (white-label) ── */
  header{ display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
  .brand{ display:flex; align-items:center; gap:12px; }
  .brand .logo{ max-height:60px; max-width:230px; object-fit:contain; display:block; }
  .brand .monogram{
    display:inline-flex; align-items:center; justify-content:center; flex:none;
    width:46px; height:46px; background:var(--accent); color:var(--accent-ink);
    font-weight:800; font-size:19px; letter-spacing:-0.02em;
  }
  .brand .wordmark{
    font-weight:800; font-size:26px; line-height:1.05; text-transform:uppercase;
    letter-spacing:-0.02em; color:var(--pri); max-width:300px;
  }
  .head-meta{ text-align:right; }
  .head-meta .tagline{ font-style:italic; font-weight:700; color:var(--pri); font-size:13px; margin-bottom:4px; }
  .head-meta .legal{ font-size:11px; color:var(--pri); }
  .head-meta .contact{ font-size:11px; color:var(--sec); }
  .rule{ height:3px; margin:12px 0 16px;
    background:linear-gradient(90deg,var(--accent) 0 96px, var(--line) 96px 100%); }

  /* ── Intro / thank-you ── */
  .eyebrow{ font-family:'JetBrains Mono','Courier New',monospace; font-size:9px;
    letter-spacing:0.18em; text-transform:uppercase; color:var(--dim); }
  .quote-title{ font-size:22px; font-weight:800; text-transform:uppercase;
    letter-spacing:-0.02em; margin:4px 0 2px; }
  .quote-sub{ color:var(--sec); font-size:11px; }
  .quote-sub strong{ color:var(--pri); }
  .intro{ margin:12px 0 4px; color:var(--sec); }

  /* ── Headings & shared body vocabulary ── */
  h2{ font-size:14px; text-transform:uppercase; letter-spacing:-0.01em; margin:22px 0 8px; }
  .part{ border:1px solid var(--line); background:var(--card); padding:14px 16px;
    margin-top:14px; page-break-inside:avoid; }
  .part-head{ display:flex; align-items:center; gap:12px; }
  .marker{ font-family:'JetBrains Mono','Courier New',monospace; font-weight:600;
    font-size:18px; line-height:1; color:var(--accent-ink); background:var(--accent);
    padding:8px 12px; min-width:40px; text-align:center; }
  .part-title{ font-size:14px; font-weight:800; text-transform:uppercase;
    letter-spacing:-0.01em; margin:0; }
  .part-note-row{ margin:8px 0 0; }
  .part-note{ color:var(--sec); font-size:11px; }
  .chip{ font-family:'JetBrains Mono','Courier New',monospace; font-size:8.5px;
    font-weight:600; letter-spacing:0.12em; text-transform:uppercase;
    color:var(--accent-ink); background:var(--accent); padding:1px 6px; vertical-align:middle; }
  ul.bullets{ margin:8px 0 0; padding-left:18px; }
  ul.bullets li{ margin-bottom:3px; }
  ol.prices{ margin:10px 0 0; padding-left:18px; }
  ol.prices li{ margin-bottom:4px; }
  .price{ font-weight:800; }
  .caveat{ color:var(--sec); font-weight:400; }

  /* generic cards/tables used by tier-based trades */
  .scope{ border-left:3px solid var(--accent); background:#fff; padding:8px 12px; }
  .statgrid{ display:flex; gap:12px; margin:12px 0 4px; }
  .stat{ flex:1; border:1px solid var(--line); background:var(--card); padding:10px 12px; }
  .stat .v{ font-size:19px; font-weight:800; }
  .stat .v small{ font-size:10px; font-weight:400; color:var(--dim); }
  .stat .l{ font-family:'JetBrains Mono','Courier New',monospace; font-size:8.5px;
    letter-spacing:0.15em; text-transform:uppercase; color:var(--dim); }
  .stat-selected{ border:2px solid var(--accent); }
  table{ width:100%; border-collapse:collapse; margin-top:8px; }
  th{ text-align:left; font-family:'JetBrains Mono','Courier New',monospace; font-size:8.5px;
    letter-spacing:0.12em; text-transform:uppercase; color:var(--dim);
    border-bottom:2px solid var(--pri); padding:5px 6px; }
  td{ border-bottom:1px solid var(--line); padding:5px 6px; vertical-align:top; }
  .num{ text-align:right; white-space:nowrap; } th.num{ text-align:right; }
  .flag{ font-family:'JetBrains Mono','Courier New',monospace; font-size:9px;
    text-transform:uppercase; color:#B45309; border:1px solid #B45309; padding:1px 6px; }
  .note{ color:var(--sec); font-size:11px; }

  /* ── Tradie identity block (customer-view section 03 parity) ── */
  .tradie{ display:flex; align-items:center; gap:14px; border:1px solid var(--line);
    background:var(--card); padding:12px 14px; margin-top:8px; page-break-inside:avoid; }
  .tradie-photo{ width:72px; height:72px; flex:none; object-fit:cover;
    border:1px solid var(--line); background:#fff; }
  .tradie-name{ font-weight:800; font-size:13px; text-transform:uppercase;
    letter-spacing:-0.01em; color:var(--pri); }
  .tradie-copy .note{ margin:4px 0 0; }

  /* ── Figure ── */
  .figure{ margin:14px 0; page-break-inside:avoid; }
  .figure img{ width:100%; max-height:420px; object-fit:contain; border:1px solid var(--line); }
  .figure figcaption{ text-align:center; color:var(--sec); font-style:italic; font-size:11px; margin-top:6px; }
  /* two-image figure: hero outline tracing + small aerial reference thumbnail */
  .figure-pair .hero{ width:100%; max-height:420px; object-fit:contain; border:1px solid var(--line); background:#fff; }
  .figure-pair .thumb{ width:42%; max-width:280px; margin:10px auto 0; }
  .figure-pair .thumb img{ display:block; width:100%; max-height:170px; object-fit:contain; border:1px solid var(--line); }
  .figure-pair .thumb figcaption{ text-align:center; color:var(--dim); font-style:italic; font-size:9.5px; margin-top:4px; }

  /* ── Please Note ── */
  .please{ margin-top:24px; border:1px solid var(--line); background:var(--card); padding:14px 16px; page-break-inside:avoid; }
  .please h3{ font-family:'JetBrains Mono','Courier New',monospace; font-size:10px;
    letter-spacing:0.16em; text-transform:uppercase; color:var(--pri); margin:0 0 8px; }
  .please ul{ margin:0; padding-left:18px; } .please li{ margin-bottom:4px; color:var(--sec); }

  .closing{ margin-top:16px; color:var(--sec); font-size:11px; }

  /* ── Repeating footer (fixed → Chromium prints it on every page) ── */
  .accentbar{ position:fixed; left:0; right:0; bottom:30px; background:var(--accent);
    color:var(--accent-ink); text-align:center; padding:6px 10px;
    font-family:'JetBrains Mono','Courier New',monospace; font-size:9px;
    letter-spacing:0.14em; text-transform:uppercase; }
  .footline{ position:fixed; left:0; right:0; bottom:8px; text-align:center;
    font-family:'JetBrains Mono','Courier New',monospace; font-size:8px;
    letter-spacing:0.12em; text-transform:uppercase; color:var(--dim); }
${reportAppearanceCss(doc.appearance)}</style>
</head>
<body>
  <header>
    <div class="brand">${wordmark(branding)}</div>
    <div class="head-meta">${headerMeta}</div>
  </header>
  ${
    doc.introBlockHtml
      ? doc.introBlockHtml
      : `<div class="rule"></div>

  <div class="intro-block">
    ${doc.eyebrow ? `<div class="eyebrow">${esc(doc.eyebrow)}</div>` : ''}
    <div class="quote-title">${esc(doc.titleText ?? 'Quotation')}</div>
    ${
      doc.introMetaHtml ??
      `<div class="quote-sub">${
        introCustomer ? `<strong>${introCustomer}</strong> · ` : ''
      }${esc(doc.dateLabel)}${doc.customerContact ? ` · ${esc(doc.customerContact)}` : ''}</div>`
    }
    ${doc.introHtml ? `<p class="intro">${doc.introHtml}</p>` : ''}
  </div>`
  }

  ${doc.bodyHtml}

  ${
    pleaseNote.length
      ? `<div class="please">
    <h3>Please Note</h3>
    <ul>${pleaseNote.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
  </div>`
      : ''
  }

  ${
    doc.closingHtml
      ? doc.closingHtml
      : doc.closingLine
        ? `<p class="closing">${esc(doc.closingLine)}</p>`
        : ''
  }

  <div class="accentbar">${esc(
    branding.licenceLine ? branding.licenceLine : branding.businessName,
  )}</div>
  <div class="footline">${esc(branding.businessName)} · ${esc(doc.footerPriceNote ?? 'Prices include GST')}</div>
</body>
</html>`
}

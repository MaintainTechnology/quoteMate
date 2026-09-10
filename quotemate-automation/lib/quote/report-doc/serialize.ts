// Pure, deterministic serializer: ReportDoc block JSON → HTML. Mirrors the
// determinism + esc() posture of lib/pdf/report-chrome.ts. Every text node is
// escaped (the same Gotenberg-Chromium XSS/SSRF sink as the existing template —
// spec §9). Only allow-listed marks emit markup. The `pricing` block delegates
// to the shared tier renderer so prices ALWAYS come from good/better/best.

import { esc } from '../../pdf/report-chrome'
import { renderQuoteTiersHtml, type QuoteReportInput } from '../report-html'
import { ALLOWED_MARKS, type ReportDoc, type ReportDocText } from './types'

type TierInput = Pick<QuoteReportInput, 'good' | 'better' | 'best' | 'selectedTier' | 'gstRegistered' | 'appliedDiscountPct' | 'quoteKind'>

const MARK_TAG: Record<string, [string, string]> = {
  bold: ['<strong>', '</strong>'],
  italic: ['<em>', '</em>'],
  underline: ['<u>', '</u>'],
  highlight: ['<mark>', '</mark>'],
}

function renderInline(content: ReportDocText[]): string {
  return content
    .map((run) => {
      let html = esc(run.text)
      const marks = (run.marks ?? []).filter((m) => ALLOWED_MARKS.includes(m))
      for (const m of marks) {
        const tag = MARK_TAG[m]
        if (tag) html = `${tag[0]}${html}${tag[1]}`
      }
      return html
    })
    .join('')
}

export function serializeReportDoc(doc: ReportDoc, tiers: TierInput): string {
  return doc.blocks
    .map((block) => {
      switch (block.type) {
        case 'title':
          return `<h1 class="doc-title">${renderInline(block.content)}</h1>`
        case 'heading':
          return `<h2>${renderInline(block.content)}</h2>`
        case 'paragraph':
          return `<p>${renderInline(block.content)}</p>`
        case 'bulletList':
          return `<ul class="bullets">${block.items
            .map((item) => `<li>${renderInline(item)}</li>`)
            .join('')}</ul>`
        case 'pricing':
          return renderQuoteTiersHtml(tiers)
        default:
          return ''
      }
    })
    .join('')
}

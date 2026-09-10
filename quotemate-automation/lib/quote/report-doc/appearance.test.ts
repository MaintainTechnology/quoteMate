import { describe, expect, it } from 'vitest'
import { brandingFromName, renderReportDocument } from '@/lib/pdf/report-chrome'
import { reportAppearanceCss } from './appearance'
import { ALLOWED_ACCENTS, type ReportStyle } from './style'

const branding = brandingFromName('Owned Electrical')
const doc = { docTitle: 'Quote', dateLabel: '9 September 2026', bodyHtml: '<h2>Saved heading</h2><p>Saved narrative</p>' }

describe('bounded saved document appearance', () => {
  it.each(['system', 'serif', 'sans', 'mono'] as const)('applies saved %s typography to the actual shared document', fontFamily => {
    const html = renderReportDocument(branding, { ...doc, appearance: { fontFamily } })
    const expected = { system: 'system-ui', serif: 'Georgia', sans: 'Manrope', mono: 'JetBrains Mono' }
    expect(html).toContain(`body{font-family:${fontFamily === 'sans' || fontFamily === 'mono' ? "'" : ''}${expected[fontFamily]}`)
    expect(html).toContain(doc.bodyHtml)
  })
  it.each(ALLOWED_ACCENTS)('applies accent %s with readable foreground ink', accentColor => {
    const css = reportAppearanceCss({ accentColor })
    expect(css).toContain(`--accent:${accentColor};`)
    const foreground = ['#FF5F00', '#16A34A'].includes(accentColor) ? '#0F1722' : '#FFFFFF'
    expect(css).toContain(`--accent-ink:${foreground};`)
    // The chosen text/background pairs must exceed WCAG normal-text contrast.
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map(offset => {
        const c = parseInt(hex.slice(offset, offset + 2), 16) / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return r * 0.2126 + g * 0.7152 + b * 0.0722
    }
    const a = luminance(accentColor), b = luminance(foreground)
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5)
  })
  it.each(['plain', 'underline', 'bar'] as const)('renders the saved %s heading treatment', headingStyle => {
    const html = renderReportDocument(branding, { ...doc, appearance: { headingStyle } })
    expect(html).toContain({ plain: 'h2{border:0;background:none;', underline: 'h2{border:0;border-bottom:3px solid var(--accent);', bar: 'h2{border:0;background:var(--accent);' }[headingStyle])
    expect(html).toContain('Saved heading')
  })
  it('returns exactly the established document when appearance is reset or absent', () => {
    const original = renderReportDocument(branding, doc)
    expect(renderReportDocument(branding, { ...doc, appearance: null })).toBe(original)
    expect(renderReportDocument(branding, { ...doc, appearance: {} })).toBe(original)
    expect(original).not.toContain('Saved quote appearance')
  })
  it.each([
    { fontFamily: "serif;}</style><script>alert(1)</script>" },
    { accentColor: "url(https://attacker.test/private)" },
    { headingStyle: '<iframe src="https://attacker.test">' },
    { logoPath: 'https://attacker.test/logo.svg' },
  ])('never renders forged style markup %j', appearance => {
    expect(renderReportDocument(branding, { ...doc, appearance: appearance as ReportStyle })).toBe(renderReportDocument(branding, doc))
  })
  it('never treats an allow-listed storage path or unknown extra key as a browser resource', () => {
    const css = reportAppearanceCss({ fontFamily: 'mono', logoPath: 'branding/owner/logo.png', rawCss: '</style><img src="https://attacker.test">' })
    expect(css).toContain('Courier New')
    expect(css).not.toContain('branding/')
    expect(css).not.toContain('attacker')
    expect(css).not.toContain('</style>')
  })
})

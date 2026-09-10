import { validateReportStyle } from './style'

const FONTS = {
  system: "system-ui,-apple-system,'Segoe UI',Arial,sans-serif",
  serif: "Georgia,'Times New Roman',serif",
  sans: "'Manrope','Segoe UI',Arial,sans-serif",
  mono: "'JetBrains Mono','Courier New',monospace",
} as const
const INK = {
  '#FF5F00': '#0F1722',
  '#0F1722': '#FFFFFF',
  '#2563EB': '#FFFFFF',
  '#16A34A': '#0F1722',
  '#9333EA': '#FFFFFF',
} as const

/** CSS consists only of constants selected by the established style allow-list.
 * Storage paths are never interpolated into HTML, CSS or a remote image URL. */
export function reportAppearanceCss(value: unknown): string {
  const style = validateReportStyle(value)
  if (!style) return ''
  const rules: string[] = []
  if (style.fontFamily) rules.push(`body{font-family:${FONTS[style.fontFamily]};}`)
  if (style.accentColor) {
    rules.push(`:root{--accent:${style.accentColor};--accent-ink:${INK[style.accentColor]};}`)
    rules.push('.ev-total-panel .ev-total-panel-label,.ev-grand .ev-grand-label{color:var(--paper);}')
  }
  if (style.headingStyle === 'plain') rules.push('h2{border:0;background:none;padding:0;color:var(--pri);}')
  if (style.headingStyle === 'underline') rules.push('h2{border:0;border-bottom:3px solid var(--accent);background:none;padding:0 0 6px;color:var(--pri);}')
  if (style.headingStyle === 'bar') rules.push('h2{border:0;background:var(--accent);color:var(--accent-ink);padding:8px 12px;}')
  // The dedicated EV template supplies a more specific heading colour later
  // in the document. Preserve the saved treatment and readable bar foreground.
  if (style.headingStyle) rules.push(`.ev-body .ev-secthead h2{color:var(${style.headingStyle === 'bar' ? '--accent-ink' : '--pri'});}`)
  return rules.length ? `\n  /* Saved quote appearance */\n  ${rules.join('\n  ')}` : ''
}

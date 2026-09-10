/* QuoteMax Brand Studio — satori-compatible templates for next/og.
 * Constraints honoured: flexbox only (every multi-child node sets display:flex),
 * no mix-blend-mode / SVG filters (duotone is pre-baked into the photos, scrims
 * are plain gradients), letterSpacing in px, gradients via backgroundImage.
 * `{curly}` words render in the accent colour.
 */
import { QM } from './tokens'
import type { Slide, Format } from './types'

const SCRIM: Record<string, string> = {
  top: 'linear-gradient(180deg, rgba(22,18,15,0.95) 0%, rgba(22,18,15,0.86) 24%, rgba(22,18,15,0.46) 46%, rgba(22,18,15,0.8) 72%, rgba(22,18,15,0.95) 100%)',
  left: 'linear-gradient(96deg, rgba(22,18,15,0.96) 0%, rgba(22,18,15,0.88) 40%, rgba(22,18,15,0.34) 78%, rgba(22,18,15,0.12) 100%)',
  faint: 'linear-gradient(180deg, rgba(22,18,15,0.93) 0%, rgba(22,18,15,0.91) 100%)',
}

// Split a string into words, flagging those inside {curly} for the accent colour.
function words(text: string): { w: string; hl: boolean }[] {
  const out: { w: string; hl: boolean }[] = []
  const push = (s: string, hl: boolean) => {
    for (const w of s.split(/\s+/).filter(Boolean)) out.push({ w, hl })
  }
  const re = /\{([^}]+)\}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index), false)
    push(m[1], true)
    last = re.lastIndex
  }
  if (last < text.length) push(text.slice(last), false)
  // Attach a lone trailing punctuation token to the previous word so a highlight
  // like "{under a minute}." doesn't render as "MINUTE ." with a gap.
  for (let i = out.length - 1; i > 0; i--) {
    if (/^[.,;:!?)]+$/.test(out[i].w)) {
      out[i - 1].w += out[i].w
      out.splice(i, 1)
    }
  }
  return out
}

// Rich display heading (uppercase, wraps by word, accent for {curly}).
function Heading({ text, size, base = QM.textPri, maxWidth }: { text: string; size: number; base?: string; maxWidth?: number }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', maxWidth: maxWidth ?? '100%' }}>
      {words(text).map((x, i) => (
        <span
          key={i}
          style={{
            fontFamily: 'Manrope',
            fontWeight: 800,
            fontSize: size,
            lineHeight: 1.02,
            letterSpacing: Math.round(size * -0.035),
            marginRight: Math.round(size * 0.24),
            color: x.hl ? QM.accent : base,
          }}
        >
          {x.w.toUpperCase()}
        </span>
      ))}
    </div>
  )
}

// Body sentence-case text with accent {curly} runs.
function Body({ text, size, color = QM.textSec, maxWidth }: { text: string; size: number; color?: string; maxWidth?: number }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', maxWidth: maxWidth ?? 840 }}>
      {words(text).map((x, i) => (
        <span
          key={i}
          style={{
            fontFamily: 'Manrope',
            fontWeight: x.hl ? 800 : 700,
            fontSize: size,
            lineHeight: 1.32,
            marginRight: Math.round(size * 0.26),
            color: x.hl ? QM.accent : color,
          }}
        >
          {x.w}
        </span>
      ))}
    </div>
  )
}

function Mark() {
  return (
    <svg width={56} height={56} viewBox="0 0 58 58">
      <rect width={58} height={58} fill={QM.accent} />
      <path d="M13 14.5h31a3 3 0 0 1 3 3v17.5a3 3 0 0 1-3 3H26l-9 8v-8h-4a3 3 0 0 1-3-3v-17.5a3 3 0 0 1 3-3z" fill={QM.accentInk} />
      <path d="M21 26.5l5.4 5.4L38.5 20.5" stroke={QM.accent} strokeWidth={4} fill="none" />
    </svg>
  )
}

function Brand() {
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <Mark />
      <span style={{ marginLeft: 18, fontFamily: 'Manrope', fontWeight: 800, fontSize: 33, letterSpacing: -1, color: QM.textPri }}>QUOTEMAX</span>
    </div>
  )
}

function Eyebrow({ parts }: { parts: string[] }) {
  return (
    <div style={{ display: 'flex', fontFamily: 'JetBrains Mono', fontWeight: 500, fontSize: 19, letterSpacing: 3, color: QM.accent }}>
      {parts.map((p, i) => (
        <span key={i} style={{ display: 'flex' }}>
          {i > 0 && <span style={{ color: QM.textDim, marginLeft: 12, marginRight: 12 }}>·</span>}
          <span>{p.toUpperCase()}</span>
        </span>
      ))}
    </div>
  )
}

function Marquee({ items }: { items: string[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', height: 90, backgroundColor: QM.accent, paddingLeft: 96, paddingRight: 96, fontFamily: 'JetBrains Mono', fontWeight: 700, fontSize: 18, letterSpacing: 2, color: QM.accentInk }}>
      {items.map((t, i) => (
        <span key={i} style={{ display: 'flex' }}>
          {i > 0 && <span style={{ opacity: 0.5, marginLeft: 22, marginRight: 22 }}>·</span>}
          <span>{t.toUpperCase()}</span>
        </span>
      ))}
    </div>
  )
}

// satori mishandles fragments passed as props/children — use explicit flex
// columns and force flex-start so nothing centres or floats.
const MIDCOL: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  width: '100%',
  justifyContent: 'center',
  alignItems: 'flex-start',
}

function Frame({ photo, bar, children }: { photo?: Slide['photo']; bar?: string[]; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        width: '100%',
        height: '100%',
        backgroundColor: QM.inkDeep,
        backgroundImage:
          'radial-gradient(700px 520px at 90% 2%, rgba(255,196,0,0.15), transparent), radial-gradient(650px 480px at 8% -4%, rgba(110,99,84,0.22), transparent)',
      }}
    >
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photo.src} width={1080} height={1350} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
      ) : null}
      {photo ? <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundImage: SCRIM[photo.scrim || 'top'] }} /> : null}
      <div style={{ display: 'flex', flexDirection: 'column', position: 'relative', width: '100%', height: '100%' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, width: '100%', alignItems: 'flex-start', padding: '96px 96px 0' }}>
          <Brand />
          {children}
        </div>
        {bar ? <Marquee items={bar} /> : null}
      </div>
    </div>
  )
}

export function renderSlide(slide: Slide, format: Format = 'li-carousel'): React.ReactElement {
  if (format !== 'li-carousel') throw new Error('Unsupported Studio format')
  const top = (() => {
    switch (slide.kind) {
      case 'stat':
        return (
          <div style={MIDCOL}>
              {slide.eyebrow && <Eyebrow parts={slide.eyebrow} />}
              <div style={{ display: 'flex', flexDirection: 'column', marginTop: 34 }}>
                {slide.lines.map(([n, l], i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'baseline' }}>
                    <span style={{ fontFamily: 'JetBrains Mono', fontWeight: 700, fontSize: 92, letterSpacing: -4, color: QM.accent, marginRight: 24 }}>{n}</span>
                    <span style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 92, letterSpacing: -3, color: QM.textPri }}>{l}</span>
                  </div>
                ))}
              </div>
              {slide.sub && <div style={{ display: 'flex', marginTop: 44 }}><Body text={slide.sub} size={33} /></div>}
              {slide.proof && (
                <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 38, fontFamily: 'JetBrains Mono', fontWeight: 500, fontSize: 16, letterSpacing: 2, color: QM.textDim }}>
                  {slide.proof.map((p, i) => (
                    <span key={i} style={{ display: 'flex' }}>
                      {i > 0 && <span style={{ color: QM.accent, marginLeft: 14, marginRight: 14 }}>›</span>}
                      <span>{p.toUpperCase()}</span>
                    </span>
                  ))}
                </div>
              )}
          </div>
        )
      case 'list':
        return (
          <div style={MIDCOL}>
              {slide.eyebrow && <Eyebrow parts={slide.eyebrow} />}
              <div style={{ display: 'flex', marginTop: 28 }}><Heading text={slide.h} size={80} maxWidth={900} /></div>
              <div style={{ display: 'flex', flexDirection: 'column', marginTop: 44 }}>
                {slide.cards.map(([l, b], i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', marginBottom: 20, padding: '32px 36px', backgroundColor: 'rgba(43,36,34,0.82)', borderWidth: 1, borderStyle: 'solid', borderColor: QM.inkLine }}>
                    <span style={{ fontFamily: 'JetBrains Mono', fontWeight: 700, fontSize: 20, letterSpacing: 3, color: QM.accent }}>{l.toUpperCase()}</span>
                    <span style={{ marginTop: 10, fontFamily: 'Manrope', fontWeight: 700, fontSize: 33, color: QM.textPri }}>{b}</span>
                  </div>
                ))}
              </div>
              {slide.sub && <div style={{ display: 'flex', marginTop: 20 }}><Body text={slide.sub} size={33} /></div>}
          </div>
        )
      case 'steps':
        return (
          <div style={MIDCOL}>
              {slide.eyebrow && <Eyebrow parts={slide.eyebrow} />}
              <div style={{ display: 'flex', marginTop: 28 }}><Heading text={slide.h} size={84} /></div>
              <div style={{ display: 'flex', flexDirection: 'column', marginTop: 44 }}>
                {slide.steps.map(([n, t, b], i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', padding: '38px 0', borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: QM.inkLine }}>
                    <span style={{ width: 118, fontFamily: 'JetBrains Mono', fontWeight: 700, fontSize: 62, letterSpacing: -3, color: QM.accent }}>{n}</span>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 39, letterSpacing: -1, color: QM.textPri }}>{t.toUpperCase()}</span>
                      <span style={{ marginTop: 8, fontFamily: 'Manrope', fontWeight: 500, fontSize: 28, color: QM.textSec }}>{b}</span>
                    </div>
                  </div>
                ))}
              </div>
          </div>
        )
      case 'quote':
        return (
          <div style={MIDCOL}>
              {slide.eyebrow && <Eyebrow parts={slide.eyebrow} />}
              <span style={{ fontFamily: 'Manrope', fontWeight: 800, fontSize: 180, lineHeight: 0.7, color: QM.accent, height: 96 }}>&ldquo;</span>
              <div style={{ display: 'flex', marginTop: 12 }}><Heading text={slide.quote} size={74} maxWidth={760} /></div>
              <div style={{ display: 'flex', marginTop: 46, fontFamily: 'JetBrains Mono', fontWeight: 500, fontSize: 23, letterSpacing: 1, color: QM.textSec }}>{slide.attrib.join(', ')}</div>
          </div>
        )
      case 'cta':
        return (
          <div style={MIDCOL}>
              {slide.eyebrow && <Eyebrow parts={slide.eyebrow} />}
              <div style={{ display: 'flex', marginTop: 28 }}><Heading text={slide.h} size={90} maxWidth={900} /></div>
              {slide.sub && <div style={{ display: 'flex', marginTop: 20 }}><Body text={slide.sub} size={34} /></div>}
              <div style={{ display: 'flex', marginTop: 50 }}>
                <div style={{ display: 'flex', alignItems: 'center', backgroundColor: QM.accent, color: QM.accentInk, paddingLeft: 46, paddingRight: 46, paddingTop: 26, paddingBottom: 26, fontFamily: 'Manrope', fontWeight: 800, fontSize: 28, letterSpacing: 1 }}>
                  {slide.btn.toUpperCase().split('→').map((part, index) => <div key={index} style={{ display: 'flex', alignItems: 'center' }}>
                    {index > 0 && <svg width={28} height={28} viewBox="0 0 28 28"><path d="M3 14h21m-8-8 8 8-8 8" fill="none" stroke={QM.accentInk} strokeWidth={2.5} /></svg>}
                    <span>{part}</span>
                  </div>)}
                </div>
              </div>
              {slide.foot && (
                <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: 38, fontFamily: 'JetBrains Mono', fontWeight: 500, fontSize: 18, letterSpacing: 1, color: QM.textDim }}>
                  {slide.foot.map((fp, i) => (
                    <span key={i} style={{ display: 'flex' }}>
                      {i > 0 && <span style={{ color: QM.accent, marginLeft: 12, marginRight: 12 }}>·</span>}
                      <span>{fp.toUpperCase()}</span>
                    </span>
                  ))}
                </div>
              )}
          </div>
        )
    }
  })()
  return (
    <Frame photo={slide.photo} bar={slide.bar}>
      {top}
    </Frame>
  )
}

// Starter content lives in ./presets (pure data). Re-exported so existing
// importers (the render route) keep working.
export { DEFAULT_CAROUSEL } from './presets'

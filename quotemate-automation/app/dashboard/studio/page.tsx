// /dashboard/studio — Brand Studio. Pick a template, edit copy, live-preview,
// export. Assets render server-side via /api/studio/render (next/og) from the
// QuoteMax design system. Chrome is product-register (serves the task); the
// output is brand-register (the command-centre look).
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { BrandMark } from '@/app/_components/BrandMark'
import { FORMATS, type Format, type Slide } from '@/lib/studio/types'
import { DEFAULT_CAROUSEL, STUDIO_PHOTOS } from '@/lib/studio/presets'
import { fetchStudioPng, renderStudioCarousel, studioBlobDataUrl, type StudioToken } from '@/lib/studio/client-render'
import { StudioAccess } from './StudioAccess'

// Pin the studio chrome to the command-centre DARK palette regardless of the
// app's light-first default, by declaring the DS dark tokens on the root (the
// bg-*/text-*/border-* utilities resolve these vars). Mirrors how .qm-quote
// re-declares the palette in-scope for the customer quote page.
const DARK = {
  '--ink-deep': '#16120F', '--ink': '#1E1813', '--ink-card': '#2B2422', '--ink-line': '#3A322C',
  '--accent': '#FFC400', '--accent-press': '#E6AC00', '--accent-soft': '#FFD23D', '--accent-ink': '#1C1812',
  '--text-pri': '#F6F1EA', '--text-sec': '#C3B8AC', '--text-dim': '#A2968A', '--warning-bright': '#F59E0B',
} as React.CSSProperties

const LABEL = ' text-[0.62rem] uppercase tracking-[0.08em] text-text-dim'
const INPUT = 'w-full bg-ink-card border border-ink-line px-3 py-2 text-sm text-text-pri outline-none focus:border-accent transition-colors'
const BTN = 'inline-flex items-center gap-2 border border-ink-line hover:border-accent text-text-pri px-4 py-2.5 text-xs uppercase tracking-[0.08em] transition-colors disabled:opacity-40 disabled:pointer-events-none'
const BTNFILL = 'inline-flex items-center gap-2 bg-accent text-accent-ink hover:bg-accent-press px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.08em] transition-colors disabled:opacity-40 disabled:pointer-events-none'

export default function StudioPage() {
  return <StudioAccess>{(identity, getToken) => <StudioEditor key={identity} getToken={getToken} />}</StudioAccess>
}

export function StudioEditor({ getToken }: { getToken: StudioToken }) {
  const [slides, setSlides] = useState<Slide[]>(DEFAULT_CAROUSEL)
  const [sel, setSel] = useState(0)
  const [format] = useState<Format>('li-carousel')
  const [busy, setBusy] = useState<null | 'png' | 'pdf'>(null)
  const [notice, setNotice] = useState('')
  const operation = useRef<AbortController | null>(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false; operation.current?.abort() }
  }, [])
  const cur = slides[sel]
  const size = FORMATS[format]

  // Debounced preview so we don't hammer the render route on every keystroke.
  const [preview, setPreview] = useState<Slide>(cur)
  useEffect(() => {
    const t = setTimeout(() => setPreview(cur), 280)
    return () => clearTimeout(t)
  }, [cur])
  const [retryPreview, setRetryPreview] = useState(0)
  const previewRequest = useMemo(() => ({ slide: preview, format, getToken, retryPreview }), [preview, format, getToken, retryPreview])
  const [rendered, setRendered] = useState<{ request: typeof previewRequest; url: string; error: string } | null>(null)
  const currentResult = rendered?.request === previewRequest ? rendered : null
  const previewUrl = currentResult?.url ?? ''
  const previewError = currentResult?.error ?? ''
  const rendering = !currentResult
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    void fetchStudioPng(previewRequest.slide, previewRequest.format, previewRequest.getToken, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setRendered({ request: previewRequest, url: objectUrl, error: '' })
    }).catch((cause) => {
      if (!controller.signal.aborted) setRendered({ request: previewRequest, url: '', error: cause instanceof Error ? cause.message : 'Preview unavailable. Your edits are still here.' })
    })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [previewRequest])

  const setCur = (next: Slide) => setSlides((s) => s.map((sl, i) => (i === sel ? next : sl)))
  const patch = (p: Partial<Slide>) => setCur({ ...cur, ...p } as Slide)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setArr = (key: string, text: string) => patch({ [key]: text.split('\n') } as any)
  const setTuple = (key: string, i: number, j: number, val: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arr = ((cur as any)[key] as string[][]).map((row, ri) => (ri === i ? row.map((c, ci) => (ci === j ? val : c)) : row))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    patch({ [key]: arr } as any)
  }

  async function downloadPNG() {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy('png'); setNotice('')
    try {
      const blob = await fetchStudioPng(cur, format, getToken, controller.signal)
      controller.signal.throwIfAborted()
      if (!active.current) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `quotemax-${format}-slide-${sel + 1}.png`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch (cause) {
      if (active.current) setNotice(controller.signal.aborted ? 'Export cancelled. Your edits are still here.' : cause instanceof Error ? cause.message : 'Export unavailable. Your edits are still here.')
    } finally {
      operation.current = null
      if (active.current) setBusy(null)
    }
  }

  async function downloadPDF() {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy('pdf'); setNotice('')
    try {
      // Snapshot in rail order; never publish a partial PDF after a failed page.
      const images = await renderStudioCarousel(slides, format, getToken, controller.signal)
      const { jsPDF } = await import('jspdf')
      controller.signal.throwIfAborted()
      const { w, h } = size
      const orient = w > h ? 'l' : 'p'
      const pdf = new jsPDF({ orientation: orient, unit: 'px', format: [w, h] })
      for (let i = 0; i < images.length; i++) {
        const dataUrl = await studioBlobDataUrl(images[i])
        controller.signal.throwIfAborted()
        if (i > 0) pdf.addPage([w, h], orient)
        pdf.addImage(dataUrl, 'PNG', 0, 0, w, h)
      }
      if (active.current) pdf.save('quotemax-carousel.pdf')
    } catch (cause) {
      if (active.current) setNotice(controller.signal.aborted ? 'Export cancelled. Your edits are still here.' : cause instanceof Error ? cause.message : 'Export unavailable. Your edits are still here.')
    } finally {
      operation.current = null
      if (active.current) setBusy(null)
    }
  }

  return (
    // 100vh minus the layout's h-11 dashboard bar — the studio fits one viewport.
    <div style={DARK} className="min-h-[calc(100vh-2.75rem)] bg-ink-deep text-text-pri flex flex-col">
      {/* Header */}
      {/* top-11: sticks below the layout's h-11 dashboard bar. */}
      <header className="sticky top-11 z-10 flex items-center justify-between gap-4 border-b border-ink-line bg-ink-deep/90 px-5 py-4 backdrop-blur">
        <div className="flex items-center gap-4">
          <BrandMark className="h-8 w-auto" />
          <div className="flex flex-col">
            <span className={LABEL}>Brand Studio · {FORMATS[format].label}</span>
            <span className="font-semibold tracking-[-0.01em]">Make an on-brand post</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className={BTN} disabled={!!busy} onClick={() => { if (window.confirm('Reset all slides? Your unsaved copy will be discarded.')) setSlides(DEFAULT_CAROUSEL) }}>Reset</button>
          <button className={BTN} onClick={downloadPNG} disabled={!!busy} aria-busy={!!busy}>{busy === 'png' ? 'Saving…' : 'Slide PNG'}</button>
          <button className={BTNFILL} onClick={downloadPDF} disabled={!!busy} aria-busy={!!busy}>{busy === 'pdf' ? 'Building…' : 'Carousel PDF'}</button>
          {busy && <button className={BTN} onClick={() => operation.current?.abort()}>Cancel export</button>}
          <Link href="/dashboard" className={BTN}>Dashboard</Link>
        </div>
      </header>
      {notice && <p role="status" className="px-5 py-3 text-sm">{notice}</p>}

      {/* Body */}
      <div className="flex flex-1 flex-col lg:grid lg:grid-cols-[210px_1fr_360px]">
        {/* Rail */}
        <nav className="flex gap-2 overflow-x-auto border-b border-ink-line p-3 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r">
          {slides.map((sl, i) => (
            <button
              key={i}
              onClick={() => { setSel(i); setPreview(slides[i]) }}
              className={`flex shrink-0 items-center gap-3 border px-3 py-2.5 text-left transition-colors ${i === sel ? 'border-accent bg-ink-card' : 'border-ink-line hover:border-ink-line/80 hover:bg-ink-card/50'}`}
            >
              <span className="font-mono text-lg font-bold leading-none text-accent">{String(i + 1).padStart(2, '0')}</span>
              <span className=" text-[0.6rem] uppercase tracking-[0.08em] text-text-sec">{sl.kind}</span>
            </button>
          ))}
        </nav>

        {/* Preview */}
        <main className="relative flex items-center justify-center bg-black/30 p-6">
          <div className="relative shadow-2xl" style={{ width: 'auto', height: '100%', maxHeight: 760, aspectRatio: `${size.w} / ${size.h}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {previewUrl && <img
              src={previewUrl}
              alt={`Slide ${sel + 1} preview`}
              onError={() => setRendered({ request: previewRequest, url: '', error: 'Preview could not be displayed. Your edits are still here.' })}
              className="h-full w-full border border-ink-line object-contain"
            />}
            {previewError && <div className="p-5"><p role="alert">{previewError}</p><button className={`${BTN} mt-3`} onClick={() => setRetryPreview((value) => value + 1)}>Retry preview</button></div>}
            {rendering && (
              <div className="absolute right-3 top-3 flex items-center gap-2 bg-ink-deep/80 px-3 py-1.5 text-[0.6rem] uppercase tracking-[0.08em] text-text-dim">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> Rendering
              </div>
            )}
          </div>
        </main>

        {/* Editor */}
        <aside className="flex flex-col gap-5 overflow-y-auto border-t border-ink-line p-5 lg:border-l lg:border-t-0">
          <Section label="Eyebrow (one per line)">
            <textarea rows={2} className={INPUT} value={(cur.eyebrow ?? []).join('\n')} onChange={(e) => setArr('eyebrow', e.target.value)} />
          </Section>

          {cur.kind === 'stat' && (
            <>
              <Section label="Stat lines (value · label)">
                <div className="flex flex-col gap-2">
                  {cur.lines.map((ln, i) => (
                    <div key={i} className="flex gap-2">
                      <input className={`${INPUT} w-24`} value={ln[0]} onChange={(e) => setTuple('lines', i, 0, e.target.value)} />
                      <input className={INPUT} value={ln[1]} onChange={(e) => setTuple('lines', i, 1, e.target.value)} />
                    </div>
                  ))}
                </div>
              </Section>
              <Section label="Subhead ({curly} = accent)"><textarea rows={2} className={INPUT} value={cur.sub ?? ''} onChange={(e) => patch({ sub: e.target.value })} /></Section>
              <Section label="Proof (one per line)"><textarea rows={3} className={INPUT} value={(cur.proof ?? []).join('\n')} onChange={(e) => setArr('proof', e.target.value)} /></Section>
            </>
          )}

          {cur.kind === 'list' && (
            <>
              <Section label="Headline ({curly} = accent)"><textarea rows={2} className={INPUT} value={cur.h} onChange={(e) => patch({ h: e.target.value })} /></Section>
              <Section label="Cards (label · body)">
                <div className="flex flex-col gap-2">
                  {cur.cards.map((c, i) => (
                    <div key={i} className="flex flex-col gap-1">
                      <input className={INPUT} value={c[0]} onChange={(e) => setTuple('cards', i, 0, e.target.value)} />
                      <input className={INPUT} value={c[1]} onChange={(e) => setTuple('cards', i, 1, e.target.value)} />
                    </div>
                  ))}
                </div>
              </Section>
              <Section label="Closing line"><textarea rows={2} className={INPUT} value={cur.sub ?? ''} onChange={(e) => patch({ sub: e.target.value })} /></Section>
            </>
          )}

          {cur.kind === 'steps' && (
            <>
              <Section label="Headline ({curly} = accent)"><textarea rows={2} className={INPUT} value={cur.h} onChange={(e) => patch({ h: e.target.value })} /></Section>
              <Section label="Steps (no · title · body)">
                <div className="flex flex-col gap-2">
                  {cur.steps.map((st, i) => (
                    <div key={i} className="flex gap-2">
                      <input className={`${INPUT} w-16`} value={st[0]} onChange={(e) => setTuple('steps', i, 0, e.target.value)} />
                      <div className="flex flex-1 flex-col gap-1">
                        <input className={INPUT} value={st[1]} onChange={(e) => setTuple('steps', i, 1, e.target.value)} />
                        <input className={INPUT} value={st[2]} onChange={(e) => setTuple('steps', i, 2, e.target.value)} />
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}

          {cur.kind === 'quote' && (
            <>
              <Section label="Quote ({curly} = accent)"><textarea rows={3} className={INPUT} value={cur.quote} onChange={(e) => patch({ quote: e.target.value })} /></Section>
              <Section label="Attribution (one per line)"><textarea rows={2} className={INPUT} value={cur.attrib.join('\n')} onChange={(e) => setArr('attrib', e.target.value)} /></Section>
              <p className=" text-[0.58rem] uppercase tracking-[0.08em] text-warning-bright">⚠ Replace with a real client quote before posting — the brand bans invented reviews.</p>
            </>
          )}

          {cur.kind === 'cta' && (
            <>
              <Section label="Headline ({curly} = accent)"><textarea rows={2} className={INPUT} value={cur.h} onChange={(e) => patch({ h: e.target.value })} /></Section>
              <Section label="Subhead"><textarea rows={2} className={INPUT} value={cur.sub ?? ''} onChange={(e) => patch({ sub: e.target.value })} /></Section>
              <Section label="Button"><input className={INPUT} value={cur.btn} onChange={(e) => patch({ btn: e.target.value })} /></Section>
              <Section label="Footer (one per line)"><textarea rows={3} className={INPUT} value={(cur.foot ?? []).join('\n')} onChange={(e) => setArr('foot', e.target.value)} /></Section>
            </>
          )}

          {/* Photo */}
          <Section label="Photo">
            <select
              className={INPUT}
              value={cur.photo?.src.replace('/studio/photos/', '').replace('.png', '') ?? 'none'}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'none') patch({ photo: null })
                else patch({ photo: { src: `/studio/photos/${v}.png`, scrim: cur.photo?.scrim ?? 'top', pos: cur.photo?.pos } })
              }}
            >
              <option value="none">No photo</option>
              {STUDIO_PHOTOS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            {cur.photo && (
              <select className={`${INPUT} mt-2`} value={cur.photo.scrim ?? 'top'} onChange={(e) => patch({ photo: { ...cur.photo!, scrim: e.target.value as 'top' | 'left' | 'faint' } })}>
                <option value="top">Scrim: top (dark top + bottom)</option>
                <option value="left">Scrim: left (for quotes)</option>
                <option value="faint">Scrim: faint (mostly hidden)</option>
              </select>
            )}
          </Section>

          <Section label="Marquee (one per line)">
            <textarea rows={3} className={INPUT} value={(cur.bar ?? []).join('\n')} onChange={(e) => setArr('bar', e.target.value)} />
          </Section>
        </aside>
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className={LABEL}>{label}</span>
      {children}
    </div>
  )
}

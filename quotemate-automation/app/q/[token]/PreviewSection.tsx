'use client'

// ════════════════════════════════════════════════════════════════════
// AI preview section on the public quote page.
//
// Receives initial state from the server-rendered page (status +
// optional pre-signed image URL). If status='generating' or 'idle' on
// arrival, polls /api/q/[token]/preview-status every 5s until the
// image lands or 90s elapses.
//
// States:
//   idle         → render skeleton (just-arrived; server may still be
//                  kicking off generation)
//   generating   → render skeleton with "Generating preview..." caption
//   ready        → render image + disclaimer
//   no_photos    → render nothing (clean, no orphan UI)
//   failed       → render nothing
//   timeout      → render "Preview taking longer than usual" line and
//                  stop polling (status still progresses in DB; on
//                  next page load it'll either be ready or failed)
// ════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react'

type Status = 'idle' | 'no_photos' | 'generating' | 'ready' | 'failed'

const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 90_000

export function PreviewSection({
  shareToken,
  initialStatus,
  initialImageUrl,
}: {
  shareToken: string
  initialStatus: Status
  initialImageUrl: string | null
}) {
  const [status, setStatus] = useState<Status>(initialStatus)
  const [imageUrl, setImageUrl] = useState<string | null>(initialImageUrl)
  const [polledForMs, setPolledForMs] = useState(0)

  useEffect(() => {
    // Only poll while the preview is still in flight.
    if (status !== 'idle' && status !== 'generating') return
    if (polledForMs >= POLL_TIMEOUT_MS) return

    const id = setTimeout(async () => {
      try {
        const res = await fetch(`/api/q/${shareToken}/preview-status`, { cache: 'no-store' })
        if (!res.ok) {
          // Treat HTTP errors as transient — keep polling until timeout.
          setPolledForMs(p => p + POLL_INTERVAL_MS)
          return
        }
        const json = await res.json() as { status: Status; image_url: string | null }
        setStatus(json.status)
        if (json.image_url) setImageUrl(json.image_url)
        setPolledForMs(p => p + POLL_INTERVAL_MS)
      } catch {
        setPolledForMs(p => p + POLL_INTERVAL_MS)
      }
    }, POLL_INTERVAL_MS)

    return () => clearTimeout(id)
  }, [status, polledForMs, shareToken])

  // ─── States that render nothing ───
  if (status === 'no_photos' || status === 'failed') return null

  const isLoading = status === 'idle' || status === 'generating'
  const isTimeout = isLoading && polledForMs >= POLL_TIMEOUT_MS

  return (
    <section className="mt-8 rounded-lg border border-zinc-200 bg-white p-5 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-600">
          ✨ AI preview — what your job could look like
        </h2>
      </div>

      {/* Image area */}
      <div className="mt-4 relative aspect-video w-full overflow-hidden rounded-md border border-zinc-100 bg-zinc-50">
        {status === 'ready' && imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={imageUrl}
            alt="AI-generated preview of the proposed work"
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-gradient-to-br from-zinc-50 to-zinc-100">
            {/* Pulsing placeholder */}
            <div className="absolute inset-0 animate-pulse bg-zinc-100" aria-hidden />
            <div className="relative flex flex-col items-center gap-2 text-zinc-500">
              <SparkleIcon />
              <span className="text-sm font-medium">
                {isTimeout ? 'Preview taking longer than usual…' : 'Generating your preview…'}
              </span>
              <span className="text-xs text-zinc-400">
                {isTimeout
                  ? "We'll have it ready next time you open this page."
                  : 'Editing your photo with the proposed work — usually 15-30s.'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Disclaimer */}
      <p className="mt-3 text-xs text-zinc-500">
        Indicative only — actual install may vary based on access, finish, and on-site conditions.
        Generated from the photo you sent.
      </p>
    </section>
  )
}

function SparkleIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

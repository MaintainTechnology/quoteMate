'use client'

// Photo upload client form. Maintain Technology brand language —
// dark canvas surfaces, dashed orange drop zones, square orange CTA,
// JetBrains Mono labels. Pairs with app/upload/[token]/page.tsx.

import { useState } from 'react'

const MAX_FILES = 5
const MAX_SIZE_BYTES = 5 * 1024 * 1024
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp']

export function UploadForm({ token }: { token: string }) {
  const [files, setFiles] = useState<File[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    setErrorMessage(null)
    if (picked.length === 0) return

    const valid: File[] = []
    for (const f of picked) {
      if (!ALLOWED_MIME.includes(f.type)) {
        setErrorMessage(`"${f.name}" isn't a supported image type. JPEG, PNG, or WebP only.`)
        return
      }
      if (f.size > MAX_SIZE_BYTES) {
        setErrorMessage(`"${f.name}" is over 5MB. Try retaking at a smaller resolution.`)
        return
      }
      valid.push(f)
    }
    if (valid.length > MAX_FILES) {
      setErrorMessage(`Up to ${MAX_FILES} photos at a time.`)
      return
    }
    setFiles(valid)
    setPreviews(valid.map((f) => URL.createObjectURL(f)))
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (files.length === 0) return
    setStatus('uploading')
    setErrorMessage(null)

    const fd = new FormData()
    for (const f of files) fd.append('photos', f, f.name)

    try {
      const res = await fetch(`/api/upload/${token}`, { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      setStatus('done')
    } catch (err: any) {
      setStatus('error')
      setErrorMessage(err?.message ?? 'Upload failed. Try again or call us back.')
    }
  }

  // ─── Success state ───
  if (status === 'done') {
    return (
      <div className="border border-success/40 bg-success/10 p-5">
        <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-[#34d399] mb-2">
          ✓ Photos received
        </div>
        <p className="text-sm leading-relaxed text-text-pri">
          Your tradie&apos;s got them. Quote will arrive by SMS shortly if it hasn&apos;t already — usually within a couple of minutes.
        </p>
      </div>
    )
  }

  const buttonDisabled = files.length === 0 || status === 'uploading'

  return (
    <form onSubmit={onSubmit}>
      {/* ─── Picker (camera + gallery) — only visible while no files chosen ─── */}
      {files.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Camera — opens device camera on mobile */}
          <label
            htmlFor="photos-camera"
            className="group relative flex flex-col items-center justify-center min-h-32 p-6 border-2 border-dashed border-ink-line bg-ink-deep/50 cursor-pointer transition-all hover:border-accent hover:bg-accent/5"
          >
            <CameraIcon className="w-7 h-7 text-accent mb-2 transition-transform group-hover:scale-110" />
            <span className="font-mono text-xs uppercase tracking-[0.15em] font-bold text-text-pri">
              Take a photo
            </span>
            <span className="mt-1 font-mono text-[0.6rem] uppercase tracking-widest text-text-dim">
              Opens camera
            </span>
            <input
              id="photos-camera"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              multiple
              onChange={onPick}
              className="sr-only"
            />
          </label>

          {/* Gallery — OS picker */}
          <label
            htmlFor="photos-gallery"
            className="group relative flex flex-col items-center justify-center min-h-32 p-6 border-2 border-dashed border-ink-line bg-ink-deep/50 cursor-pointer transition-all hover:border-accent hover:bg-accent/5"
          >
            <GalleryIcon className="w-7 h-7 text-accent mb-2 transition-transform group-hover:scale-110" />
            <span className="font-mono text-xs uppercase tracking-[0.15em] font-bold text-text-pri">
              Choose from gallery
            </span>
            <span className="mt-1 font-mono text-[0.6rem] uppercase tracking-widest text-text-dim">
              Pick existing
            </span>
            <input
              id="photos-gallery"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={onPick}
              className="sr-only"
            />
          </label>
        </div>
      ) : (
        // ─── Files chosen — single replace-all surface ───
        <label
          htmlFor="photos-replace"
          className="block w-full p-5 border-2 border-dashed border-accent bg-accent/5 cursor-pointer transition-colors hover:bg-accent/10 text-center"
        >
          <div className="font-mono text-xs uppercase tracking-[0.15em] font-bold text-accent">
            {files.length} photo{files.length > 1 ? 's' : ''} ready
          </div>
          <div className="mt-1 font-mono text-[0.6rem] uppercase tracking-widest text-text-dim">
            Tap to swap or add more
          </div>
          <input
            id="photos-replace"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={onPick}
            className="sr-only"
          />
        </label>
      )}

      {/* ─── Preview thumbnails (4:3 aspect, 2-up mobile / 3-up desktop) ─── */}
      {previews.length > 0 ? (
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {previews.map((src, i) => (
            <div
              key={i}
              className="relative aspect-4/3 overflow-hidden border border-ink-line bg-ink-deep"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={`preview ${i + 1}`}
                className="h-full w-full object-cover"
              />
              <span className="absolute top-2 right-2 font-mono text-[0.55rem] uppercase tracking-widest bg-ink-deep/90 text-text-pri px-1.5 py-0.5 rounded-sm border border-ink-line">
                {String(i + 1).padStart(2, '0')}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {/* ─── Error line ─── */}
      {errorMessage ? (
        <p className="mt-4 font-mono text-xs uppercase tracking-widest text-[#fca5a5] bg-danger/10 border-l-2 border-danger px-3 py-2.5">
          {errorMessage}
        </p>
      ) : null}

      {/* ─── Submit CTA ─── */}
      <button
        type="submit"
        disabled={buttonDisabled}
        className={`mt-6 w-full px-5 py-4 font-mono text-xs sm:text-sm uppercase tracking-[0.15em] font-bold transition-colors ${
          buttonDisabled
            ? 'bg-ink-line text-text-dim cursor-not-allowed'
            : 'bg-accent hover:bg-accent-press text-white cursor-pointer'
        }`}
      >
        {status === 'uploading'
          ? 'Uploading…'
          : files.length === 0
          ? 'Pick a photo first'
          : `Send ${files.length} photo${files.length > 1 ? 's' : ''} →`}
      </button>

      {/* ─── Footnote ─── */}
      <p className="mt-3 font-mono text-[0.6rem] uppercase tracking-widest text-text-dim text-center">
        JPEG · PNG · WebP · max 5MB each · up to {MAX_FILES} photos
      </p>
    </form>
  )
}

/* ─── Icons (inline SVG to match the brand's no-emoji aesthetic) ─── */

function CameraIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M3 7h3l2-3h8l2 3h3a1 1 0 011 1v11a1 1 0 01-1 1H3a1 1 0 01-1-1V8a1 1 0 011-1z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

function GalleryIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="3" y="3" width="18" height="18" rx="1" />
      <circle cx="9" cy="9" r="2" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  )
}

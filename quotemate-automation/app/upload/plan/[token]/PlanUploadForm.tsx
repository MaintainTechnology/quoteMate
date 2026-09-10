'use client'

// Plan-PDF upload client form (SMS estimator). One PDF, posted to
// /api/upload/plan/[token]; success confirms the durable analysis receipt.

import { useState } from 'react'

const MAX_SIZE_BYTES = 32 * 1024 * 1024

export function PlanUploadForm({ token }: { token: string }) {
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null
    setErrorMessage(null)
    if (!picked) return
    if (picked.type && picked.type !== 'application/pdf') {
      setErrorMessage(`"${picked.name}" isn't a PDF.`)
      return
    }
    if (picked.size > MAX_SIZE_BYTES) {
      setErrorMessage(`"${picked.name}" is over 32MB — ask your designer for a lighter export.`)
      return
    }
    setFile(picked)
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    setStatus('uploading')
    setErrorMessage(null)

    const fd = new FormData()
    fd.append('pdf', file, file.name)

    try {
      const res = await fetch(`/api/upload/plan/${token}`, { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setStatus('done')
    } catch (err) {
      setStatus('error')
      setErrorMessage(err instanceof Error ? err.message : 'Upload failed. Try again.')
    }
  }

  if (status === 'done') {
    return (
      <div className="border border-success/40 bg-success/10 p-5">
        <div className="font-mono text-[0.65rem] uppercase tracking-[0.15em] text-[#34d399] mb-2">
          ✓ Plan received — saved for analysis
        </div>
        <p className="text-sm leading-relaxed text-text-pri">
          Your drawing is saved for analysis and your tradie’s review. We’ll send an SMS
          update as it progresses. Your tradie needs to approve the quote before prices
          are shared. You can close this page.
        </p>
      </div>
    )
  }

  const buttonDisabled = !file || status === 'uploading'

  return (
    <form onSubmit={onSubmit}>
      <label
        htmlFor="plan-pdf"
        className={`group relative flex flex-col items-center justify-center min-h-32 p-6 border-2 border-dashed cursor-pointer transition-all ${
          file
            ? 'border-accent bg-accent/5 hover:bg-accent/10'
            : 'border-ink-line bg-ink-deep/50 hover:border-accent hover:bg-accent/5'
        }`}
      >
        <PdfIcon className="w-7 h-7 text-accent mb-2 transition-transform group-hover:scale-110" />
        <span className="font-mono text-xs uppercase tracking-[0.15em] font-bold text-text-pri text-center break-all">
          {file ? file.name : 'Choose your plan PDF'}
        </span>
        <span className="mt-1 font-mono text-[0.6rem] uppercase tracking-widest text-text-dim">
          {file ? `${(file.size / 1e6).toFixed(1)} MB · tap to swap` : 'PDF · max 32MB'}
        </span>
        <input
          id="plan-pdf"
          type="file"
          accept="application/pdf,.pdf"
          onChange={onPick}
          className="sr-only"
        />
      </label>

      {errorMessage ? (
        <p className="mt-4 font-mono text-xs uppercase tracking-widest text-[#fca5a5] bg-danger/10 border-l-2 border-danger px-3 py-2.5">
          {errorMessage}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={buttonDisabled}
        className={`mt-6 w-full px-5 py-4 font-mono text-xs sm:text-sm uppercase tracking-[0.15em] font-bold transition-colors ${
          buttonDisabled
            ? 'bg-ink-line text-text-dim cursor-not-allowed'
            : 'bg-accent hover:bg-accent-press text-white cursor-pointer'
        }`}
      >
        {status === 'uploading' ? 'Uploading…' : file ? 'Analyse my plan →' : 'Pick a PDF first'}
      </button>

      <p className="mt-3 font-mono text-[0.6rem] uppercase tracking-widest text-text-dim text-center">
        Analysis takes 1–2 minutes · results arrive by SMS
      </p>
    </form>
  )
}

function PdfIcon({ className = '' }: { className?: string }) {
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
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 15h6M9 11h2" />
    </svg>
  )
}

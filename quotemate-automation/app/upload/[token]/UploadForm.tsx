'use client'

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

  if (status === 'done') {
    return (
      <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '1rem' }}>
        <strong style={{ color: '#15803d' }}>✓ Photos received</strong>
        <p style={{ marginTop: '0.5rem', color: '#166534', lineHeight: 1.5 }}>
          Thanks — we'll incorporate them into your quote and send it via SMS shortly.
        </p>
      </div>
    )
  }

  const buttonDisabled = files.length === 0 || status === 'uploading'

  const pickerCommon: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '1.25rem 1rem', textAlign: 'center',
    border: '2px dashed #94a3b8', borderRadius: 12, cursor: 'pointer',
    background: '#f8fafc', color: '#0f172a', fontWeight: 500,
    minHeight: '5rem', lineHeight: 1.4,
  }

  return (
    <form onSubmit={onSubmit}>
      {files.length === 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
          {/* Take a photo — opens device camera (mobile only) */}
          <label htmlFor="photos-camera" style={pickerCommon}>
            📷&nbsp;Take a photo
            <input
              id="photos-camera"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              multiple
              onChange={onPick}
              style={{ display: 'none' }}
            />
          </label>

          {/* Choose from gallery / files — no capture attribute, OS picker decides */}
          <label htmlFor="photos-gallery" style={pickerCommon}>
            🖼&nbsp;Choose from gallery
            <input
              id="photos-gallery"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              onChange={onPick}
              style={{ display: 'none' }}
            />
          </label>
        </div>
      ) : (
        <label htmlFor="photos-gallery-replace" style={{ ...pickerCommon, display: 'block' }}>
          {files.length} photo{files.length > 1 ? 's' : ''} ready · tap to change
          <input
            id="photos-gallery-replace"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            onChange={onPick}
            style={{ display: 'none' }}
          />
        </label>
      )}

      {previews.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 8, marginTop: '1rem' }}>
          {previews.map((src, i) => (
            <img
              key={i}
              src={src}
              alt={`preview ${i + 1}`}
              style={{ width: '100%', aspectRatio: '1 / 1', objectFit: 'cover', borderRadius: 8, border: '1px solid #e2e8f0' }}
            />
          ))}
        </div>
      ) : null}

      {errorMessage ? (
        <p style={{ color: '#b91c1c', marginTop: '1rem', fontSize: '0.9rem' }}>{errorMessage}</p>
      ) : null}

      <button
        type="submit"
        disabled={buttonDisabled}
        style={{
          marginTop: '1.25rem', width: '100%', padding: '0.85rem',
          background: buttonDisabled ? '#cbd5e1' : '#0f172a',
          color: 'white', border: 'none', borderRadius: 10,
          fontSize: '1rem', fontWeight: 600,
          cursor: buttonDisabled ? 'not-allowed' : 'pointer',
        }}
      >
        {status === 'uploading' ? 'Uploading…' : 'Send photos'}
      </button>
    </form>
  )
}

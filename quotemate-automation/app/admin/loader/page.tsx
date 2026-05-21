'use client'

// Admin bulk loader — upload a Services / Materials CSV, review the preview
// diff, Approve (commit) or Roll back. Admin-only: every API call carries
// the Supabase access token and the routes enforce the admin_users gate, so
// a non-admin simply gets a 403 here.

import { useCallback, useState } from 'react'
import { getBrowserSupabase } from '@/lib/supabase/client'

type StagedRow = { row_class: 'NEW' | 'UPDATE'; payload: Record<string, unknown> }
type RejectedRow = { line: number; errors: string[] }
type PreviewCsv = {
  csv: string
  target_table: string
  summary: { newCount: number; updateCount: number; rejectedCount: number }
  forcedDisabledCount: number
  stagedRows: StagedRow[]
  rejected: RejectedRow[]
}

type BatchStatus = 'staged' | 'committed' | 'rolled_back'

const num = (v: unknown) => (v == null ? '' : String(v))

export default function AdminLoaderPage() {
  const [servicesFile, setServicesFile] = useState<File | null>(null)
  const [materialsFile, setMaterialsFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [structural, setStructural] = useState<{ csv: string; errors: string[] }[] | null>(null)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null)
  const [preview, setPreview] = useState<PreviewCsv[] | null>(null)

  const token = useCallback(async () => {
    const { data } = await getBrowserSupabase().auth.getSession()
    return data.session?.access_token ?? null
  }, [])

  function resetAll() {
    setServicesFile(null)
    setMaterialsFile(null)
    setError(null)
    setInfo(null)
    setStructural(null)
    setBatchId(null)
    setBatchStatus(null)
    setPreview(null)
  }

  async function handleUpload() {
    setError(null)
    setInfo(null)
    setStructural(null)
    if (!servicesFile && !materialsFile) {
      setError('Choose a Services and/or Materials CSV first.')
      return
    }
    setBusy(true)
    try {
      const t = await token()
      if (!t) {
        setError('Not signed in. Sign in with an admin account, then retry.')
        return
      }
      const payload: Record<string, string> = {
        idempotencyKey: crypto.randomUUID(),
      }
      if (servicesFile) payload.services = await servicesFile.text()
      if (materialsFile) payload.materials = await materialsFile.text()

      const res = await fetch('/api/admin/loader/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
        body: JSON.stringify(payload),
      })
      const data = await res.json()

      if (res.status === 403) {
        setError('Not authorized — your account is not on the admin list.')
        return
      }
      if (data?.error === 'structural_validation_failed') {
        setStructural(data.csvs ?? [])
        return
      }
      if (!res.ok || !data?.ok) {
        setError(data?.message ?? data?.error ?? `Upload failed (${res.status}).`)
        return
      }
      if (data.idempotentReplay) {
        setInfo('This upload was already submitted — showing the existing batch.')
        setBatchId(data.batchId)
        setBatchStatus((data.batch?.status as BatchStatus) ?? 'staged')
        setPreview(null)
        return
      }
      setBatchId(data.batchId)
      setBatchStatus('staged')
      setPreview(data.preview as PreviewCsv[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function callBatch(action: 'approve' | 'rollback', body?: object) {
    const t = await token()
    if (!t) {
      setError('Session expired — sign in again.')
      return null
    }
    const res = await fetch(`/api/admin/loader/batch/${batchId}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify(body ?? {}),
    })
    return { res, data: await res.json() }
  }

  async function handleApprove() {
    if (!batchId) return
    setError(null)
    setInfo(null)
    setBusy(true)
    try {
      let out = await callBatch('approve')
      if (!out) return
      if (out.data?.error === 'reprice_confirmation_required') {
        const ok = window.confirm(
          `${out.data.message}\n\nProceed and re-price ${out.data.updateCount} live service(s)?`,
        )
        if (!ok) return
        out = await callBatch('approve', { confirmReprice: true })
        if (!out) return
      }
      if (!out.res.ok || !out.data?.ok) {
        setError(out.data?.message ?? out.data?.error ?? 'Approve failed.')
        return
      }
      const r = out.data.result ?? {}
      setBatchStatus('committed')
      setInfo(
        r.already_committed
          ? 'Batch was already committed.'
          : `Committed ${r.committed ?? 0} row(s)${r.skipped ? `, skipped ${r.skipped}` : ''}.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRollback() {
    if (!batchId) return
    setError(null)
    setInfo(null)
    setBusy(true)
    try {
      const out = await callBatch('rollback')
      if (!out) return
      if (!out.res.ok || !out.data?.ok) {
        setError(out.data?.message ?? out.data?.error ?? 'Rollback failed.')
        return
      }
      const r = out.data.result ?? {}
      setBatchStatus('rolled_back')
      setInfo(
        r.already_rolled_back
          ? 'Batch was already rolled back.'
          : `Rolled back — reverted ${r.reverted ?? 0}, deleted ${r.deleted ?? 0}.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const totalStaged =
    preview?.reduce((n, p) => n + p.stagedRows.length, 0) ?? 0

  return (
    <div className="mx-auto max-w-4xl p-6 text-sm">
      <h1 className="mb-1 text-xl font-semibold">Admin bulk loader</h1>
      <p className="mb-6 text-gray-500">
        Upload a Services or Materials CSV, review the preview, then Approve.
        Nothing touches the live catalogue until you Approve — and every
        commit can be rolled back.
      </p>

      {/* ── Upload form ─────────────────────────────────────────────── */}
      {!batchId && (
        <div className="space-y-4 rounded border border-gray-200 p-4">
          <p className="text-gray-500">
            Need the format? Download a template with the exact headers:{' '}
            <a
              className="text-blue-600 underline"
              href="/api/admin/loader/template?csv=services"
            >
              Services CSV
            </a>
            {' · '}
            <a
              className="text-blue-600 underline"
              href="/api/admin/loader/template?csv=materials"
            >
              Materials CSV
            </a>
          </p>
          <label className="block">
            <span className="font-medium">Services CSV</span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="mt-1 block w-full"
              onChange={(e) => setServicesFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <label className="block">
            <span className="font-medium">Materials CSV</span>
            <input
              type="file"
              accept=".csv,text/csv"
              className="mt-1 block w-full"
              onChange={(e) => setMaterialsFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={handleUpload}
            className="rounded bg-gray-900 px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Validating…' : 'Upload & preview'}
          </button>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-red-700">
          {error}
        </div>
      )}
      {info && (
        <div className="mt-4 rounded border border-blue-300 bg-blue-50 p-3 text-blue-800">
          {info}
        </div>
      )}

      {/* ── Structural rejection ────────────────────────────────────── */}
      {structural && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-red-700">
          <p className="font-medium">The file was rejected before any row was staged:</p>
          {structural.map((s) => (
            <div key={s.csv} className="mt-2">
              <span className="font-medium capitalize">{s.csv} CSV</span>
              <ul className="ml-5 list-disc">
                {s.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* ── Preview diff ────────────────────────────────────────────── */}
      {preview && (
        <div className="mt-6 space-y-6">
          {preview.map((p) => (
            <div key={p.csv} className="rounded border border-gray-200 p-4">
              <h2 className="font-semibold capitalize">{p.csv} → {p.target_table}</h2>
              <p className="text-gray-600">
                {p.summary.newCount} new · {p.summary.updateCount} update ·{' '}
                {p.summary.rejectedCount} rejected
                {p.forcedDisabledCount > 0 &&
                  ` · ${p.forcedDisabledCount} forced off (live trade)`}
              </p>

              {p.stagedRows.length > 0 && (
                <table className="mt-3 w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b text-gray-500">
                      <th className="py-1 pr-3">Class</th>
                      <th className="py-1 pr-3">Trade</th>
                      <th className="py-1 pr-3">Name</th>
                      <th className="py-1 pr-3">Price ex-GST</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.stagedRows.map((r, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="py-1 pr-3">
                          <span
                            className={
                              r.row_class === 'NEW'
                                ? 'text-emerald-700'
                                : 'text-amber-700'
                            }
                          >
                            {r.row_class}
                          </span>
                        </td>
                        <td className="py-1 pr-3">{num(r.payload.trade)}</td>
                        <td className="py-1 pr-3">{num(r.payload.name)}</td>
                        <td className="py-1 pr-3">
                          {num(r.payload.default_unit_price_ex_gst)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {p.rejected.length > 0 && (
                <div className="mt-3 text-red-700">
                  <p className="font-medium">Rejected rows (not staged):</p>
                  <ul className="ml-5 list-disc">
                    {p.rejected.map((r) => (
                      <li key={r.line}>
                        Line {r.line}: {r.errors.join(' ')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Actions ─────────────────────────────────────────────────── */}
      {batchId && (
        <div className="mt-6 flex items-center gap-3">
          {batchStatus === 'staged' && (
            <button
              type="button"
              disabled={busy || totalStaged === 0}
              onClick={handleApprove}
              className="rounded bg-emerald-600 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Working…' : `Approve & commit (${totalStaged})`}
            </button>
          )}
          {batchStatus === 'committed' && (
            <button
              type="button"
              disabled={busy}
              onClick={handleRollback}
              className="rounded bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Working…' : 'Roll back this batch'}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={resetAll}
            className="rounded border border-gray-300 px-4 py-2 font-medium disabled:opacity-50"
          >
            {batchStatus === 'committed' || batchStatus === 'rolled_back'
              ? 'New upload'
              : 'Cancel'}
          </button>
          <span className="text-gray-400">batch {batchId.slice(0, 8)} · {batchStatus}</span>
        </div>
      )}
    </div>
  )
}

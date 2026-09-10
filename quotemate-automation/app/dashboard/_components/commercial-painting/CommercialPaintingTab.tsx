'use client'

// Commercial Painting tab — upload → classify → AI takeoff (+
// reconciliation) → confirm → price → quote (strategy v11).
//
// One workspace, three numbered stages in the Maintain command-centre
// idiom. The run is persisted server-side at every step (paint_runs +
// plan_uploads + plan_extractions), so a reload resumes from the
// history rail rather than losing work.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/nextjs'
import {
  ChevronRight,
  Eye,
  FileText,
  History,
  Image as ImageIcon,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { PlanOverlay } from '../PlanOverlay'
import type {
  PaintDocType,
  PaintTakeoffItem,
  PricedPaintBom,
  ReconcileFlag,
} from '@/lib/commercial-painting/types'
import { PaintTakeoffEditor } from './PaintTakeoffEditor'
import { PaintPricedSummary } from './PaintPricedSummary'
import EstimatorChatbot from '../EstimatorChatbot'
import { PaintPreviewPanel } from './PaintPreviewPanel'
import { PaginationControls, usePagination } from '../Pagination'
import { StatusPill, type Tone } from '../quote-ui'
import { getAuthToken } from '@/lib/auth/client-token'
import { browserPaintSaveReceiptStore, PaintSavePassSchema, PaintSaveScopeSchema, readPaintRecoveryResult,
  readSavedPaintResult, samePaintSaveScope, type PaintSaveReceipt, type PaintSaveScope, type SavedPaintResult } from '@/lib/commercial-painting/browser-save-receipt'
import { PaintCorrectionInputSchema, PaintCorrectionSizeError, PaintEditSnapshotSchema, paintEditSnapshotMatchesView, type PaintEditSnapshot } from '@/lib/commercial-painting/correction-contract'
import { usePaintCorrections } from '@/lib/commercial-painting/use-paint-corrections'

const API = '/api/tenant/commercial-painting'

const DOC_TYPE_LABELS: Record<PaintDocType, string> = {
  plan_set: 'Plan set',
  measurement_takeoff: 'Measurements',
  services_layout: 'Services layout',
  site_photo: 'Site photo',
  other: 'Other',
}

const DOC_TYPES: PaintDocType[] = [
  'plan_set',
  'measurement_takeoff',
  'services_layout',
  'site_photo',
  'other',
]

/** The extraction really does take minutes on a full drawing set. */
const EXTRACT_STEPS = [
  'Reading the drawing register…',
  'Finding the finishes schedule…',
  'Measuring rooms and ceiling heights…',
  'Building the surface takeoff…',
  'Reconciling against the measurements doc…',
] as const

// Run lifecycle → one calm neutral chip for the history rail; colour now
// lives only in the tone dot (extracting pulses in place of the old inline
// spinner). Keep labels human, not the raw enum.
const RUN_STATUS: Record<string, { label: string; tone: Tone; pulse?: boolean }> = {
  draft: { label: 'Draft', tone: 'dim' },
  extracting: { label: 'Extracting', tone: 'warn', pulse: true },
  ready: { label: 'Ready', tone: 'good' },
  priced: { label: 'Priced', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
}

function runStatusMeta(status: string): { label: string; tone: Tone; pulse?: boolean } {
  return RUN_STATUS[status] ?? { label: status, tone: 'dim' }
}

type UploadRow = {
  id: string
  filename: string
  doc_type: PaintDocType
  size_bytes: number | null
}

type RunRow = {
  id: string
  job_name: string | null
  site_address: string | null
  status: string
  created_at: string
  public_token: string | null
}

type ExtractionState = {
  id: string
  items: PaintTakeoffItem[]
  flags: ReconcileFlag[]
  finishesSchedule: Array<{ code: string; product: string; sheen: string; surfaces: string }>
  overallNote: string
  measurementLineCount: number
  measurementParseFailed: boolean
  hasCorrections: boolean
}

async function paintScopeRequest(expected?: PaintSaveScope) {
  const token = await getAuthToken()
  if (!token) throw new Error('Sign in again to verify quote recovery.')
  const init = { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' as const }
  const res = await fetch(`${API}/save-quote?scope=1`, { ...init, signal: AbortSignal.timeout(10000) })
  const body = await res.json()
  if (!res.ok || !body?.ok) throw new Error('The active account could not be verified. Quote recovery is retained.')
  const scope = PaintSaveScopeSchema.parse({ userId: body.userId, tenantId: body.tenantId })
  if (expected && !samePaintSaveScope(scope, expected)) throw new Error('The active account changed. Reopen commercial painting to continue.')
  return { scope, init }
}

export default function CommercialPaintingTab({ accessToken }: { accessToken: string | null }) {
  const { userId, isLoaded } = useAuth()
  const [identity, setIdentity] = useState<{ key: string; scope: PaintSaveScope } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const key = userId ?? accessToken ?? 'signed-out'
  useEffect(() => {
    if (!isLoaded) return
    let current = true
    void paintScopeRequest().then(({ scope }) => {
      if (current && (!userId || userId === scope.userId)) { setIdentity({ key, scope }); setError(null) }
      else if (current) setError('The active account changed. Sign in again to continue.')
    }).catch(e => { if (current) setError(e instanceof Error ? e.message : 'The active account could not be verified.') })
    return () => { current = false }
  }, [isLoaded, key, userId, retry])
  if (!identity || identity.key !== key) return <div role="status">{error ?? 'Verifying saved quote recovery…'}
    {error && <button type="button" onClick={() => setRetry(value => value + 1)}>Check account again</button>}</div>
  return <CommercialPaintingWorkspace key={`${identity.scope.userId}:${identity.scope.tenantId}`} accessToken={accessToken} scope={identity.scope} />
}

export function CommercialPaintingWorkspace({ accessToken, scope }: { accessToken: string | null; scope: PaintSaveScope }) {
  const [runId, setRunId] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [statusNote, setStatusNote] = useState<string | null>(null)
  const [jobName, setJobName] = useState('')
  const [siteAddress, setSiteAddress] = useState('')
  const [uploads, setUploads] = useState<UploadRow[]>([])
  const [recentRuns, setRecentRuns] = useState<RunRow[]>([])
  const {
    page: runPage,
    setPage: setRunPage,
    totalPages: runTotalPages,
    pageItems: cpaintRows,
    startIndex: runStart,
    endIndex: runEnd,
    total: runTotal,
  } = usePagination(recentRuns, { urlKey: 'cpaint_page' })

  const [extraction, setExtraction] = useState<ExtractionState | null>(null)
  const [editorRevision, setEditorRevision] = useState(0)
  const [editSnapshot, setEditSnapshot] = useState<PaintEditSnapshot | null>(null)
  const [bom, setBom] = useState<PricedPaintBom | null>(null)
  const [pricingProof, setPricingProof] = useState<{ runId: string; extractionId: string; digest: string; pricedAt: string } | null>(null)
  const pricingGeneration = useRef(0)
  function invalidatePricing() {
    pricingGeneration.current += 1
    setPricingProof(null)
    setSavedQuote(null)
  }
  useEffect(() => () => { pricingGeneration.current += 1 }, [])

  const [uploading, setUploading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [extractStep, setExtractStep] = useState(0)
  const [pricing, setPricing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pendingSave, setPendingSave] = useState<PaintSaveReceipt | null>(null)
  const [recoveryReady, setRecoveryReady] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [recoveredQuote, setRecoveredQuote] = useState<SavedPaintResult | null>(null)
  const verifyCorrectionScope = useCallback(() => paintScopeRequest(scope), [scope])
  const corrections = usePaintCorrections(scope, verifyCorrectionScope)
  const saveBusy = useRef(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const [savedQuote, setSavedQuote] = useState<{
    quoteViewUrl: string
    pdfUrl: string | null
    delivery?: { attempted: boolean; sent?: boolean; mms?: boolean; reason?: string }
  } | null>(null)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // ── In-tab document viewer (shared PlanOverlay for PDFs, <img> for
  // photos). Files are fetched once with the auth header and cached for
  // the session — they never round-trip again on page changes.
  const [viewer, setViewer] = useState<
    | { uploadId: string; filename: string; kind: 'pdf'; file: File }
    | { uploadId: string; filename: string; kind: 'image'; objectUrl: string }
    | null
  >(null)
  const [viewerLoading, setViewerLoading] = useState<string | null>(null)
  const fileCache = useRef(new Map<string, { kind: 'pdf'; file: File } | { kind: 'image'; objectUrl: string }>())

  // Mint a FRESH token per request — a Clerk session token expires ~60s after
  // the dashboard captured `accessToken` at mount, so reusing the prop 401s.
  // getAuthToken() refreshes (Clerk) or reuses the legacy Supabase session;
  // fall back to the prop only if it yields nothing. Every call site awaits
  // this helper, so the token is always fresh at the moment of the fetch.
  const authed = useCallback(
    async (init?: RequestInit): Promise<RequestInit> => {
      const token = (await getAuthToken()) ?? accessToken
      return {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      }
    },
    [accessToken],
  )

  // Walk staged copy while the model reads the set.
  useEffect(() => {
    if (!extracting) return
    const t = setInterval(
      () => setExtractStep((i) => Math.min(i + 1, EXTRACT_STEPS.length - 1)),
      18000,
    )
    return () => clearInterval(t)
  }, [extracting])

  // History rail for resume.
  useEffect(() => {
    if (!accessToken) return
    void (async () => {
      const init = await authed()
      fetch(`${API}/runs`, init)
        .then((r) => r.json())
        .then((b) => {
          if (b?.ok) setRecentRuns(b.runs as RunRow[])
        })
        .catch(() => {})
    })()
  }, [accessToken, authed])

  const loadRun = useCallback(
    async (id: string) => {
      const generation = ++pricingGeneration.current
      setPricingProof(null)
      setErrMsg(null)
      try {
      const { init } = await paintScopeRequest(scope)
      if (!active.current || generation !== pricingGeneration.current) return null
      const res = await fetch(`${API}/run/${id}`, init)
      const body = await res.json()
      const baselineResponse = await fetch(`${API}/run/${id}/corrections`, init)
      const baselineBody = await baselineResponse.json()
      if (!active.current || generation !== pricingGeneration.current) return null
      const baseline = PaintEditSnapshotSchema.safeParse(baselineBody.snapshot)
      if (!res.ok || !body?.ok || body.run?.id !== id || !baselineResponse.ok || !baselineBody.ok || !baseline.success || baseline.data.runId !== id ||
        baseline.data.extractionId !== (body.extraction?.id ?? null)) {
        setErrMsg('Could not load that run.')
        return null
      }
      await paintScopeRequest(scope)
      if (!active.current || generation !== pricingGeneration.current) return null
      setEditSnapshot(baseline.data)
      setRunId(body.run.id)
      setRunStatus((body.run.status as string) ?? null)
      setStatusNote((body.run.status_note as string) ?? null)
      setJobName(baseline.data.job_name ?? '')
      setSiteAddress(baseline.data.site_address ?? '')
      setSavedQuote(null)
      setViewer(null)
      setUploads(
        (body.uploads as Array<UploadRow & { doc_type: string | null }>).map((u) => ({
          ...u,
          doc_type: (u.doc_type ?? 'other') as PaintDocType,
        })),
      )
      if (body.extraction) {
        setEditorRevision(previous => previous + 1)
        const sheets = (body.extraction.sheets_used ?? {}) as {
          finishes_schedule?: ExtractionState['finishesSchedule']
          flags?: ReconcileFlag[]
          measurement_line_count?: number
          measurement_parse_failed?: boolean
        }
        const corrected = baseline.data.corrected_items as PaintTakeoffItem[] | null
        setExtraction({
          id: body.extraction.id,
          items:
            Array.isArray(corrected) && corrected.length > 0
              ? corrected
              : (baseline.data.items as PaintTakeoffItem[]),
          flags: sheets.flags ?? [],
          finishesSchedule: sheets.finishes_schedule ?? [],
          overallNote: body.extraction.overall_note ?? '',
          measurementLineCount: sheets.measurement_line_count ?? 0,
          measurementParseFailed: sheets.measurement_parse_failed === true,
          hasCorrections: Array.isArray(corrected) && corrected.length > 0,
        })
        const matchingSource = paintEditSnapshotMatchesView(baseline.data, body.run, body.extraction)
        setBom(matchingSource ? (body.extraction.priced_bom as PricedPaintBom | null) ?? null : null)
        const review = PaintSavePassSchema.safeParse({ paintRunId: body.run.id, extractionId: body.extraction.id,
          pricingProof: body.extraction.pricing_review?.pricingProof, pricedAt: body.extraction.pricing_review?.pricedAt })
        setPricingProof(matchingSource && review.success
          ? { runId: review.data.paintRunId, extractionId: review.data.extractionId, digest: review.data.pricingProof, pricedAt: review.data.pricedAt } : null)
        if (!matchingSource) setErrMsg('The saved takeoff changed while opening this run. Review the current quantities and price again.')
      } else {
        setExtraction(null)
        setBom(null)
      }
      return baseline.data
      } catch {
        if (active.current && generation === pricingGeneration.current) setErrMsg('Could not load the current saved run. Your working copy has been retained.')
        return null
      }
    },
    [scope, setSavedQuote],
  )

  // ── Stage 1: documents ─────────────────────────────────────────────
  // Three steps: sign (get direct-to-storage URLs), PUT each file
  // straight to Supabase Storage (Vercel 413s any function body over
  // ~4.5 MB, so files can't go through the API), then complete
  // (classify + register).
  async function uploadFiles(files: FileList | File[]) {
    if (corrections.blocked || pendingSave || saveBusy.current) return
    const list = [...files]
    if (list.length === 0) return
    setUploading(true)
    setErrMsg(null)
    const fail = (body: { error?: string; detail?: string; filename?: string } | null, status?: number) => {
      setErrMsg(
        body?.error === 'file_too_large'
          ? `${body.filename} is over 32 MB.`
          : body?.error === 'unsupported_type'
            ? `${body.filename} isn’t a PDF or image.`
            : body?.detail
              ? `Upload failed: ${body.detail}`
              : body?.error
                ? `Upload failed (${body.error}). Please try again.`
                : `Upload failed (HTTP ${status ?? '?'}). Please try again.`,
      )
    }
    try {
      const signRes = await fetch(`${API}/upload/sign`, await authed({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: list.map((f) => ({ name: f.name, size: f.size, type: f.type })),
          ...(jobName.trim() ? { job_name: jobName.trim() } : {}),
          ...(siteAddress.trim() ? { site_address: siteAddress.trim() } : {}),
          ...(runId ? { paint_run_id: runId } : {}),
        }),
      }))
      const signBody = await signRes.json().catch(() => null)
      if (!signRes.ok || !signBody?.ok) {
        fail(signBody, signRes.status)
        return
      }
      const targets = signBody.uploads as Array<{ uploadId: string; signedUrl: string }>

      for (let i = 0; i < list.length; i++) {
        const put = await fetch(targets[i].signedUrl, {
          method: 'PUT',
          headers: { 'content-type': list[i].type, 'x-upsert': 'true' },
          body: list[i],
        })
        if (!put.ok) {
          setErrMsg(`Uploading ${list[i].name} failed (HTTP ${put.status}). Please try again.`)
          return
        }
      }

      const res = await fetch(`${API}/upload/complete`, await authed({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paintRunId: signBody.paintRunId,
          files: list.map((f, i) => ({
            uploadId: targets[i].uploadId,
            name: f.name,
            size: f.size,
            type: f.type,
          })),
        }),
      }))
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) {
        fail(body, res.status)
        return
      }
      setRunId(body.paintRunId)
      setUploads((prev) => [
        ...prev,
        ...(body.uploads as Array<UploadRow & { doc_type: string }>).map((u) => ({
          ...u,
          doc_type: u.doc_type as PaintDocType,
        })),
      ])
      await loadRun(body.paintRunId)
    } catch {
      setErrMsg('Upload failed. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  async function setDocType(uploadId: string, docType: PaintDocType) {
    if (corrections.blocked || pendingSave || saveBusy.current) return
    setUploads((prev) => prev.map((u) => (u.id === uploadId ? { ...u, doc_type: docType } : u)))
    await fetch(`${API}/upload/${uploadId}`, await authed({
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc_type: docType }),
    })).catch(() => {})
  }

  async function openViewer(upload: UploadRow) {
    if (viewer?.uploadId === upload.id) {
      setViewer(null) // toggle off
      return
    }
    const cached = fileCache.current.get(upload.id)
    if (cached) {
      setViewer({ uploadId: upload.id, filename: upload.filename, ...cached })
      return
    }
    setViewerLoading(upload.id)
    setErrMsg(null)
    try {
      // The API hands back a short-lived signed storage URL; the bytes
      // come straight from Supabase (plan sets exceed Vercel's ~4.5 MB
      // function-response cap).
      const res = await fetch(`${API}/upload/${upload.id}/file`, await authed())
      const meta = await res.json().catch(() => null)
      if (!res.ok || !meta?.ok || !meta.url) {
        setErrMsg('Could not load that document. Please try again.')
        return
      }
      const fileRes = await fetch(meta.url as string)
      if (!fileRes.ok) {
        setErrMsg('Could not load that document. Please try again.')
        return
      }
      const raw = await fileRes.blob()
      const mime = (meta.mime as string) || raw.type
      const blob = raw.type === mime ? raw : new Blob([raw], { type: mime })
      const entry =
        mime === 'application/pdf'
          ? ({ kind: 'pdf', file: new File([blob], upload.filename, { type: mime }) } as const)
          : ({ kind: 'image', objectUrl: URL.createObjectURL(blob) } as const)
      fileCache.current.set(upload.id, entry)
      setViewer({ uploadId: upload.id, filename: upload.filename, ...entry })
    } catch {
      setErrMsg('Could not load that document. Please try again.')
    } finally {
      setViewerLoading(null)
    }
  }

  async function removeUpload(uploadId: string) {
    if (corrections.blocked || pendingSave || saveBusy.current) return
    try {
      const res = await fetch(`${API}/upload/${uploadId}`, await authed({ method: 'DELETE' }))
      const body = await res.json().catch(() => null)
      if (res.status === 409) {
        setErrMsg(
          body?.detail ??
            'This document is the source of the run’s takeoff and can’t be removed. Start a new run instead.',
        )
        return
      }
      if (!res.ok) {
        setErrMsg('Removing the document failed. Please try again.')
        return
      }
      setUploads((prev) => prev.filter((u) => u.id !== uploadId))
      fileCache.current.delete(uploadId)
      setViewer((v) => (v?.uploadId === uploadId ? null : v))
    } catch {
      setErrMsg('Removing the document failed. Please try again.')
    }
  }

  const hasPlanSet = uploads.some((u) => u.doc_type === 'plan_set')

  // ── Stage 2: AI takeoff ────────────────────────────────────────────
  async function runTakeoff() {
    if (!runId || !editSnapshot || pendingSave || saveBusy.current || !recoveryReady || corrections.blocked) return
    setExtracting(true)
    const generation = ++pricingGeneration.current
    setPricingProof(null)
    setExtractStep(0)
    setErrMsg(null)
    setBom(null)
    setSavedQuote(null)
    try {
      const applied = await corrections.save(runId, PaintCorrectionInputSchema.parse({ operationId: crypto.randomUUID(),
        expectedRevision: editSnapshot.revision, extractionId: editSnapshot.extractionId, job_name: jobName, site_address: siteAddress }), null)
      if (!applied || !active.current || !await corrections.acknowledge(applied.copy, applied.result)) return
      setEditSnapshot({ ...editSnapshot, revision: applied.result.revision, job_name: jobName.trim() || null, site_address: siteAddress.trim() || null })
      const extractInit = await authed({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paintRunId: runId }),
      })
      if (!active.current || generation !== pricingGeneration.current) return
      const res = await fetch(`${API}/extract`, extractInit)
      const body = await res.json()
      if (!active.current || generation !== pricingGeneration.current) return
      if (!res.ok || !body.ok) {
        setErrMsg(
          body?.error === 'plan_set_required'
            ? 'Mark one document as the plan set first.'
            : body?.error === 'extraction_in_flight'
              ? 'An extraction is already running for this run — it takes a few minutes. Use the run in “Recent runs” to pick up the result.'
              : body?.error === 'rate_limited'
                ? body?.detail ?? 'Takeoff limit reached — try again shortly.'
                : 'The takeoff failed — you can retry. Nothing was lost.',
        )
        if (body?.error !== 'extraction_in_flight') setRunStatus('failed')
        return
      }
      setRunStatus('ready')
      setStatusNote(null)
      setExtraction({
        id: body.extractionId,
        items: body.items as PaintTakeoffItem[],
        flags: body.flags as ReconcileFlag[],
        finishesSchedule: body.finishesSchedule ?? [],
        overallNote: body.overallNote ?? '',
        measurementLineCount: body.measurementLineCount ?? 0,
        measurementParseFailed: body.measurementParseFailed === true,
        hasCorrections: false,
      })
      if (body.job?.name && !jobName) setJobName(body.job.name)
      if (body.job?.address && !siteAddress) setSiteAddress(body.job.address)
      await loadRun(runId)
    } catch {
      setErrMsg('The takeoff failed or the connection dropped — reopen the run from “Recent runs” in a few minutes to check for a result before retrying.')
    } finally {
      setExtracting(false)
    }
  }

  // ── Stage 2→3: confirm + price ─────────────────────────────────────
  async function confirmAndPrice(items: PaintTakeoffItem[], labourRatePerHr: number | null) {
    if (!runId || !extraction || !editSnapshot || editSnapshot.extractionId !== extraction.id || pendingSave || saveBusy.current || !recoveryReady || corrections.blocked) return
    invalidatePricing()
    const generation = pricingGeneration.current
    setPricing(true)
    setErrMsg(null)
    // Edits invalidate the previous pricing AND any quote saved from it.
    setBom(null)
    setSavedQuote(null)
    let correctionConfirmed = false
    try {
      const applied = await corrections.save(runId, PaintCorrectionInputSchema.parse({ operationId: crypto.randomUUID(),
        expectedRevision: editSnapshot.revision, extractionId: extraction.id, corrected_items: items, job_name: jobName, site_address: siteAddress }), labourRatePerHr)
      if (!applied || !active.current || generation !== pricingGeneration.current) return
      correctionConfirmed = true
      if (!await corrections.acknowledge(applied.copy, applied.result)) return
      setEditSnapshot({ ...editSnapshot, revision: applied.result.revision, corrected_items: items,
        job_name: jobName.trim() || null, site_address: siteAddress.trim() || null })
      setExtraction((prev) => (prev ? { ...prev, items, hasCorrections: true } : prev))
      const priceInit = await authed({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paintRunId: runId,
          extractionId: extraction.id,
          expectedRevision: applied.result.revision,
          ...(labourRatePerHr != null ? { labourRatePerHr } : {}),
        }),
      })
      if (!active.current || generation !== pricingGeneration.current) return
      const res = await fetch(`${API}/price`, priceInit)
      const body = await res.json()
      if (generation !== pricingGeneration.current) return
      if (!res.ok || !body.ok) {
        setErrMsg('Pricing failed. The takeoff is saved — try pricing again.')
        return
      }
      setBom(body.bom as PricedPaintBom)
      const review = PaintSavePassSchema.safeParse({ paintRunId: runId, extractionId: extraction.id, pricingProof: body.pricingProof, pricedAt: body.pricedAt })
      setPricingProof(review.success ? { runId, extractionId: extraction.id, digest: review.data.pricingProof, pricedAt: review.data.pricedAt } : null)
    } catch (error) {
      setErrMsg(error instanceof PaintCorrectionSizeError ? error.message : correctionConfirmed ? 'Pricing failed after the correction was confirmed saved. Review the takeoff before pricing again.'
        : 'The correction was not confirmed saved. Review the fields and check retained recovery before trying again.')
    } finally {
      setPricing(false)
    }
  }

  async function saveAsQuote() {
    if (saveBusy.current || pendingSave || corrections.blocked || !recoveryReady || recoveryError || !runId || !extraction || pricingProof?.runId !== runId || pricingProof.extractionId !== extraction.id) return
    const generation = pricingGeneration.current
    const pass = PaintSavePassSchema.parse({ paintRunId: runId, extractionId: extraction.id, pricingProof: pricingProof.digest, pricedAt: pricingProof.pricedAt })
    saveBusy.current = true
    setSaving(true)
    setErrMsg(null)
    try {
      const { init } = await paintScopeRequest(scope)
      if (!active.current || generation !== pricingGeneration.current) return
      const store = browserPaintSaveReceiptStore(scope)
      const receipt = await store.begin(pass)
      if (!active.current || generation !== pricingGeneration.current) { await store.complete(pass); return }
      setPendingSave(receipt)
      const res = await fetch(`${API}/save-quote`, {
        method: 'POST',
        headers: { ...init.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          ...pass,
          ...(customerPhone.trim() ? { customerPhone: customerPhone.trim() } : {}),
          ...(customerName.trim() ? { customerName: customerName.trim() } : {}),
        }),
      })
      const body = await res.json()
      if (!active.current) return
      if (!res.ok || !body.ok) {
        const rejected = (res.status === 400 && ['invalid_json', 'invalid_request', 'invalid_customer_phone'].includes(body.error)) ||
          (res.status === 404 && ['run_not_found', 'extraction_not_found'].includes(body.error)) ||
          (res.status === 409 && ['pricing_changed', 'pricing_review_required', 'pricing_proof_required', 'released_quote_immutable'].includes(body.error)) ||
          (res.status === 422 && ['not_priced', 'no_items', 'invalid_takeoff', 'invalid_pricing', 'tenant_pricing_required', 'inspection_required'].includes(body.error))
        if (rejected) {
          await paintScopeRequest(scope)
          if (!active.current) return
          await store.complete(pass)
          if (!active.current) return
          setPendingSave(null); setPricingProof(null)
          setErrMsg(body.error === 'invalid_customer_phone' ? 'Check the customer mobile, then review and re-price before saving.' : 'The save was rejected before a quote was created. Review and re-price before saving.')
        } else setRecoveryError('Saving could not be confirmed. Check the previous save before another quote save.')
        return
      }
      const result = readSavedPaintResult(body, pass)
      await paintScopeRequest(scope)
      if (!active.current) return
      await store.complete(pass)
      if (!active.current) return
      setPendingSave(null); setRecoveryError(null); setRecoveredQuote(result)
      if (generation === pricingGeneration.current) setSavedQuote(result)
    } catch (e) {
      if (active.current) {
        try { setPendingSave(browserPaintSaveReceiptStore(scope).read()) } catch { /* preserve the storage failure below */ }
        setRecoveryError(e instanceof Error ? e.message : 'Saving could not be confirmed. Check the previous save before trying again.')
      }
    } finally {
      saveBusy.current = false
      if (active.current) setSaving(false)
    }
  }

  const checkPreviousSave = useCallback(async (receipt: PaintSaveReceipt) => {
    if (saveBusy.current) return
    saveBusy.current = true; setSaving(true); setRecoveryError(null)
    try {
      const { init } = await paintScopeRequest(scope)
      if (!active.current) return
      const params = new URLSearchParams(receipt.pass)
      const res = await fetch(`${API}/save-quote?${params}`, init)
      const body = await res.json()
      if (!active.current) return
      if (!res.ok) throw new Error('The previous save could not be verified. Its recovery receipt is retained.')
      const result = readPaintRecoveryResult(body, receipt.pass)
      if (!result) { setRecoveryError('No saved result is visible yet. The previous request may still complete; check again before another save.'); return }
      await paintScopeRequest(scope)
      if (!active.current) return
      await browserPaintSaveReceiptStore(scope).complete(receipt.pass)
      if (!active.current) return
      setPendingSave(null); setRecoveredQuote(result); setRecoveryError(null)
    } catch (e) {
      if (active.current) setRecoveryError(e instanceof Error ? e.message : 'The previous save could not be verified.')
    } finally { saveBusy.current = false; if (active.current) setSaving(false) }
  }, [scope, setPendingSave, setRecoveredQuote, setRecoveryError, setSaving])
  useEffect(() => {
    let current = true
    // Reading browser storage after hydration also keeps the server render free
    // of private account state. Opening a retained attempt only performs GETs.
    void Promise.resolve().then(() => browserPaintSaveReceiptStore(scope).read()).then(receipt => {
      if (!current) return
      setPendingSave(receipt); setRecoveryReady(true)
      if (receipt) void checkPreviousSave(receipt)
    }).catch(e => { if (current) setRecoveryError(e instanceof Error ? e.message : 'Quote recovery storage is unavailable.') })
    return () => { current = false }
  }, [scope, checkPreviousSave])

  function resetRun() {
    if (pendingSave || saveBusy.current || corrections.blocked) return
    invalidatePricing()
    setRunId(null)
    setEditSnapshot(null)
    setRunStatus(null)
    setStatusNote(null)
    setJobName('')
    setSiteAddress('')
    setUploads([])
    setExtraction(null)
    setBom(null)
    setSavedQuote(null)
    setCustomerName('')
    setCustomerPhone('')
    setViewer(null)
    setErrMsg(null)
  }

  // Low-confidence banner: >50% of m² in low-confidence lines (spec §8).
  const lowShare = (() => {
    if (!extraction) return 0
    const m2 = extraction.items.filter((i) => i.unit === 'm2' && !i.excluded)
    const total = m2.reduce((s, i) => s + i.quantity, 0)
    if (total <= 0) return 0
    return m2.filter((i) => i.confidence === 'low').reduce((s, i) => s + i.quantity, 0) / total
  })()

  const inputClass =
    'w-full border border-ink-line bg-ink-deep px-3.5 py-2.5 text-sm text-text-pri placeholder:text-text-dim outline-none transition-colors focus:border-accent'

  return (
    <div className="space-y-8">
      {(!corrections.ready || corrections.copy || corrections.error) && <div role="status" className="rounded-card border border-warning-bright/40 bg-ink-card px-4 py-3 text-sm text-text-sec">
        <p>{corrections.outcome ? 'The retained correction is saved. Review the current saved run before pricing.' : corrections.error ??
          (corrections.copy?.rejected ? 'The correction was rejected without saving. Your working copy is retained.' : corrections.copy ? 'A previous correction needs verification. Its exact working copy is encrypted in this browser.' : 'Loading encrypted correction recovery…')}</p>
        {corrections.copy && <>
          <details className="mt-3"><summary>Retained correction working copy</summary>
            <p>Job: {corrections.copy.input.job_name || 'Untitled'} · Address: {corrections.copy.input.site_address || 'Unspecified'}</p>
            <p>Labour: {corrections.copy.labourRatePerHr == null ? 'Use saved tenant rate' : `$${corrections.copy.labourRatePerHr}/hr`}</p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap">{JSON.stringify(corrections.copy.input.corrected_items ?? [], null, 2)}</pre>
          </details>
          {!corrections.copy.rejected && !corrections.outcome && <>
            <button type="button" disabled={corrections.busy} onClick={() => void corrections.check(corrections.copy!)} className="mt-3 mr-5 text-accent">Check previous correction</button>
            <button type="button" disabled={corrections.busy} onClick={() => void corrections.retry()} className="mt-3 text-accent">Retry exact correction</button>
          </>}
          {(corrections.copy.rejected || corrections.outcome) && <button type="button" disabled={corrections.busy} className="mt-3 text-accent" onClick={() => {
            const retained = corrections.copy!
            void loadRun(retained.runId).then(async baseline => { if (baseline) await corrections.acknowledge(retained) })
              .catch(() => setErrMsg('The current run could not be read. Your retained working copy is still available.'))
          }}>{corrections.copy.rejected ? 'Discard retained copy and reload latest saved data' : 'Review saved corrections'}</button>}
        </>}
        {!corrections.copy && corrections.error && <button type="button" onClick={() => void corrections.reloadStorage()} className="mt-3 text-accent">Check correction storage</button>}
      </div>}
      {(pendingSave || recoveryError || !recoveryReady) && <div role="status" className="rounded-card border border-warning-bright/40 bg-ink-card px-4 py-3 text-sm text-text-sec">
        <p>{recoveryError ?? (pendingSave ? 'A previous quote save needs verification. Its reviewed pricing pass is retained in this browser.' : 'Loading quote recovery…')}</p>
        {pendingSave && <button type="button" disabled={saving} onClick={() => void checkPreviousSave(pendingSave)} className="mt-3 font-semibold text-accent">Check previous save</button>}
        {!pendingSave && recoveryError && <button type="button" disabled={saving} onClick={() => {
          try { setPendingSave(browserPaintSaveReceiptStore(scope).read()); setRecoveryReady(true); setRecoveryError(null) }
          catch (e) { setRecoveryError(e instanceof Error ? e.message : 'Quote recovery storage is unavailable.') }
        }} className="mt-3 font-semibold text-accent">Check recovery storage</button>}
      </div>}
      {recoveredQuote && <div role="status" className="rounded-card border border-ink-line bg-ink-card px-4 py-3 text-sm text-text-sec">
        Previous quote save verified. <a href={recoveredQuote.quoteViewUrl} target="_blank" rel="noreferrer" className="text-accent">Open saved quote ↗</a>
        {recoveredQuote.pdfUrl && <> · <a href={recoveredQuote.pdfUrl} target="_blank" rel="noreferrer" className="text-accent">Tender PDF ↗</a></>}
      </div>}
      {errMsg && (
        <p role="alert" className="rounded-card border border-warning-bright/40 bg-ink-card px-4 py-3 text-sm text-text-sec">
          {errMsg}
        </p>
      )}
      <fieldset disabled={corrections.blocked || !!pendingSave || saving} className="min-w-0 space-y-8">

      {/* Run-status banners — a resumed run must explain itself. */}
      {runStatus === 'failed' && !extracting && (
        <div role="alert" className="rounded-card border border-warning-bright/40 bg-ink-card px-4 py-3">
          <p className=" text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-warning">
            Last takeoff failed
          </p>
          <p className="mt-1 text-sm text-text-sec">
            {statusNote ?? 'The model could not read the documents.'} Adjust the documents if needed, then run the takeoff again.
          </p>
        </div>
      )}
      {runStatus === 'extracting' && !extracting && (
        <div className="rounded-card edge-lit flex flex-wrap items-center gap-3 border border-ink-line bg-ink-card px-4 py-3">
          <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
          <p className="flex-1 text-sm text-text-sec">
            A takeoff is running on the server for this run — it takes a few minutes.
          </p>
          <button
            type="button"
            onClick={() => { if (runId) void loadRun(runId) }}
            className="inline-flex cursor-pointer items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-accent transition-colors hover:text-accent-press"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Check now
          </button>
        </div>
      )}

      {/* ── 01 · Documents ──────────────────────────────────────────── */}
      <section className="rounded-card border border-ink-line bg-ink-card p-6 sm:p-7">
        <div className="flex items-start gap-5">
          <span className="font-mono text-4xl font-bold leading-none text-accent sm:text-5xl">01</span>
          <div className="min-w-0 flex-1">
            <h3 className="font-extrabold uppercase tracking-tight text-text-pri">Job documents</h3>
            <p className="mt-1 text-sm leading-relaxed text-text-sec">
              Drop the architectural plan set (required) plus anything else you have —
              a painter’s measurement takeoff, services layouts, site photos. Each file
              is auto-classified; correct it if we guessed wrong.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className=" text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-dim">Job name</span>
                <input value={jobName} onChange={(e) => { invalidatePricing(); setJobName(e.target.value) }} placeholder="IGA Swan Street fit-out" className={`mt-1 ${inputClass}`} />
              </label>
              <label className="block">
                <span className=" text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-dim">Site address</span>
                <input value={siteAddress} onChange={(e) => { invalidatePricing(); setSiteAddress(e.target.value) }} placeholder="480 Swan St, Richmond VIC" className={`mt-1 ${inputClass}`} />
              </label>
            </div>

            <label
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); void uploadFiles(e.dataTransfer.files) }}
              className={`rounded-card mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 border border-dashed px-6 py-9 text-center transition-colors ${
                dragOver ? 'border-accent bg-ink' : 'border-ink-line bg-ink-deep hover:border-accent'
              }`}
            >
              <UploadCloud className="h-6 w-6 text-accent" aria-hidden />
              <span className="text-sm text-text-sec">
                Drag PDFs or photos here, or <span className="font-semibold text-accent">browse</span>
              </span>
              <span className=" text-[0.62rem] uppercase tracking-[0.08em] text-text-dim">
                PDF · PNG · JPG · up to 32 MB each
              </span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="application/pdf,image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = '' }}
              />
            </label>

            {uploads.length > 0 && (
              <ul className="mt-4 divide-y divide-ink-line border border-ink-line">
                {uploads.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-3 bg-ink-deep px-4 py-3">
                    {u.doc_type === 'site_photo'
                      ? <ImageIcon className="h-4 w-4 shrink-0 text-text-dim" aria-hidden />
                      : <FileText className="h-4 w-4 shrink-0 text-text-dim" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate text-sm text-text-pri" title={u.filename}>{u.filename}</span>
                    <select
                      value={u.doc_type}
                      onChange={(e) => void setDocType(u.id, e.target.value as PaintDocType)}
                      aria-label={`Document type for ${u.filename}`}
                      className="rounded-ctl cursor-pointer border border-ink-line bg-ink-card px-2 py-1.5 text-[0.68rem] uppercase tracking-[0.08em] text-text-sec outline-none focus:border-accent"
                    >
                      {DOC_TYPES.map((t) => (
                        <option key={t} value={t}>{DOC_TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void openViewer(u)}
                      aria-label={`View ${u.filename}`}
                      aria-pressed={viewer?.uploadId === u.id}
                      className={`cursor-pointer p-1 transition-colors hover:text-accent ${
                        viewer?.uploadId === u.id ? 'text-accent' : 'text-text-dim'
                      }`}
                    >
                      {viewerLoading === u.id
                        ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        : <Eye className="h-4 w-4" aria-hidden />}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeUpload(u.id)}
                      aria-label={`Remove ${u.filename}`}
                      className="cursor-pointer p-1 text-text-dim transition-colors hover:text-warning"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* In-tab document viewer — the Estimator's PlanOverlay for
                PDFs (full-page browsing), plain image for site photos. */}
            {viewer && (
              <div className="mt-4">
                <div className="rounded-card flex items-center gap-3 border border-b-0 border-ink-line bg-ink-deep px-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-accent">
                    Viewing · {viewer.filename}
                  </span>
                  <button
                    type="button"
                    onClick={() => setViewer(null)}
                    aria-label="Close viewer"
                    className="cursor-pointer p-1 text-text-dim transition-colors hover:text-text-pri"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                {viewer.kind === 'pdf' ? (
                  <div className="[&>div]:mt-0 [&>div]:border-t">
                    <PlanOverlay file={viewer.file} items={[]} selectedIdx={null} requirePins={false} />
                  </div>
                ) : (
                  <div className="rounded-card border border-ink-line bg-ink-deep p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={viewer.objectUrl} alt={viewer.filename} className="max-h-[34rem] w-auto" />
                  </div>
                )}
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={() => void runTakeoff()}
                disabled={!hasPlanSet || uploading || extracting || !!pendingSave || saving || !recoveryReady}
                aria-busy={uploading || extracting}
                className="rounded-ctl inline-flex cursor-pointer items-center gap-2.5 bg-accent px-5 py-3 text-sm font-bold uppercase tracking-[0.08em] text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50"
              >
                {extracting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    <span aria-live="polite">{EXTRACT_STEPS[extractStep]}</span>
                  </>
                ) : uploading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Uploading…
                  </>
                ) : (
                  'Run AI takeoff'
                )}
              </button>
              {!hasPlanSet && uploads.length > 0 && (
                <span className="text-sm text-text-dim">Mark one document as the plan set to continue.</span>
              )}
              {extracting && (
                <span className="text-sm text-text-dim">A full drawing set takes 2–4 minutes.</span>
              )}
              {runId && !extracting && (
                <button type="button" disabled={!!pendingSave || saving} onClick={resetRun} className="inline-flex cursor-pointer items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors hover:text-text-sec disabled:opacity-50">
                  <Plus className="h-3.5 w-3.5" aria-hidden /> New run
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── 02 · Confirm the takeoff ────────────────────────────────── */}
      {extraction && (
        <section className="rounded-card border border-ink-line bg-ink-card p-6 sm:p-7">
          <div className="flex items-start gap-5">
            <span className="font-mono text-4xl font-bold leading-none text-accent sm:text-5xl">02</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-4">
                <h3 className="font-extrabold uppercase tracking-tight text-text-pri">Confirm the takeoff</h3>
                {uploads.some((u) => u.doc_type === 'plan_set') && (
                  <button
                    type="button"
                    onClick={() => {
                      const planSet = uploads.find((u) => u.doc_type === 'plan_set')
                      if (planSet) void openViewer(planSet)
                    }}
                    className="inline-flex cursor-pointer items-center gap-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-accent transition-colors hover:text-accent-press"
                  >
                    <Eye className="h-3.5 w-3.5" aria-hidden />
                    {viewer ? 'Close plan viewer' : 'View plan set'}
                  </button>
                )}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-text-sec">
                {extraction.measurementLineCount > 0
                  ? `Reconciled against the painter’s ${extraction.measurementLineCount}-line measurement takeoff — resolve the flags, adjust anything, then price.`
                  : 'Check quantities, systems and heights, then price. Nothing is priced until you confirm.'}
              </p>

              {extraction.measurementParseFailed && (
                <p role="alert" className="rounded-card mt-4 border border-warning-bright/40 bg-ink-deep px-4 py-3 text-sm text-text-sec">
                  The measurements document could not be transcribed, so this takeoff is
                  plan-only — no reconciliation flags were produced. Check quantities
                  against the painter’s takeoff by hand, or re-run after fixing the document.
                </p>
              )}

              {lowShare > 0.5 && (
                <p role="alert" className="rounded-card mt-4 border border-warning-bright/40 bg-ink-deep px-4 py-3 text-sm text-text-sec">
                  More than half this takeoff’s area is low-confidence. Recommend a site
                  measure before this quote goes anywhere near a tender.
                </p>
              )}

              <PaintTakeoffEditor
                key={`${extraction.id}:${editorRevision}`}
                initialItems={extraction.items}
                flags={extraction.flags}
                finishesSchedule={extraction.finishesSchedule}
                overallNote={extraction.overallNote}
                pricing={pricing}
                disabled={!!pendingSave || saving || !recoveryReady}
                defaultLabourRate={bom?.labour.ratePerHr ?? null}
                onConfirm={(items, labourRatePerHr) => void confirmAndPrice(items, labourRatePerHr)}
                onDirty={invalidatePricing}
              />
            </div>
          </div>
        </section>
      )}

      {/* ── 03 · Tender price ───────────────────────────────────────── */}
      {bom && extraction && runId && (
        <section className="rounded-card border border-ink-line bg-ink-card p-6 sm:p-7">
          <div className="flex items-start gap-5">
            <span className="font-mono text-4xl font-bold leading-none text-accent sm:text-5xl">03</span>
            <div className="min-w-0 flex-1">
              <h3 className="font-extrabold uppercase tracking-tight text-text-pri">Tender price</h3>
              <PaintPricedSummary bom={bom} />

              {/* Customer delivery — text the quote + tender PDF (MMS), the
                  same send path as the electrical/plumbing/solar SMS quotes. */}
              <div className="mt-6 border-t border-ink-line pt-5">
                <p className=" text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-text-dim">
                  Customer details (optional)
                </p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <input
                    type="text"
                    value={customerName}
                    maxLength={120}
                    disabled={saving || !!pendingSave}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Customer name (optional)"
                    className={inputClass}
                  />
                  <input
                    type="tel"
                    inputMode="tel"
                    value={customerPhone}
                    maxLength={30}
                    disabled={saving || !!pendingSave}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    placeholder="Customer mobile e.g. 0412 345 678"
                    className={inputClass}
                  />
                </div>
                <p className="mt-2 text-xs text-text-dim">
                  Save creates a private draft. Review the saved quote before choosing a separate customer send action.
                </p>
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  disabled={saving || pricing || !!pendingSave || !recoveryReady || !!recoveryError || !!savedQuote || pricingProof?.runId !== runId || pricingProof.extractionId !== extraction.id}
                  aria-busy={saving}
                  onClick={() => void saveAsQuote()}
                  className="rounded-ctl inline-flex cursor-pointer items-center gap-2.5 bg-accent px-5 py-3 text-sm font-bold uppercase tracking-[0.08em] text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Saving quote…
                    </>
                  ) : savedQuote ? (
                    'Quote saved'
                  ) : (
                    'Save as quote'
                  )}
                </button>
                {savedQuote && (
                  <span className="flex flex-wrap items-center gap-4 text-[0.7rem] font-semibold uppercase tracking-[0.08em]">
                    <a href={savedQuote.quoteViewUrl} target="_blank" rel="noreferrer" className="cursor-pointer text-accent transition-colors hover:text-accent-press">
                      Open quote ↗
                    </a>
                    {savedQuote.pdfUrl && (
                      <a href={savedQuote.pdfUrl} target="_blank" rel="noreferrer" className="cursor-pointer text-accent transition-colors hover:text-accent-press">
                        Tender PDF ↗
                      </a>
                    )}
                    {savedQuote.delivery?.attempted && savedQuote.delivery.sent && (
                      <span className="text-success">
                        Texted to customer ✓{savedQuote.delivery.mms ? ' (incl. PDF)' : ''}
                      </span>
                    )}
                    {savedQuote.delivery?.attempted && !savedQuote.delivery.sent && (
                      <span className="text-warning">Couldn’t text the customer — share the link above</span>
                    )}
                  </span>
                )}
              </div>
              {(!pricingProof || pricingProof.runId !== runId || pricingProof.extractionId !== extraction.id) && (
                <p role="status" className="mt-3 text-sm text-warning">Review and re-price the takeoff before saving this quote.</p>
              )}

              <PaintPreviewPanel
                accessToken={accessToken}
                paintRunId={runId}
                hasSitePhoto={uploads.some((u) => u.doc_type === 'site_photo')}
              />

              {/* Grounded chatbot — answers customer/tradie questions about this
                  estimate from the run's own File Search store (uploads + PDF). */}
              <EstimatorChatbot
                estimator="paint"
                sessionId={runId}
                accessToken={accessToken}
                jobLabel={customerName.trim() || undefined}
              />
            </div>
          </div>
        </section>
      )}

      {/* ── History rail ────────────────────────────────────────────── */}
      {recentRuns.length > 0 && (
        <section className="rounded-card border border-ink-line bg-ink-card">
          <header className="flex items-center gap-3 border-b border-ink-line px-5 py-3.5">
            <History className="h-4 w-4 shrink-0 text-accent" aria-hidden />
            <h3 className=" text-xs font-semibold uppercase tracking-[0.08em] text-text-pri">
              Recent runs
            </h3>
            <span className="border border-ink-line px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold leading-none text-text-sec">
              {recentRuns.length}
            </span>
            <span className="ml-auto hidden text-xs text-text-sec sm:block">
              Pick up where you left off
            </span>
          </header>
          <ul className="divide-y divide-ink-line">
            {cpaintRows.map((r) => {
              const meta = runStatusMeta(r.status)
              const isActive = r.id === runId
              const title = r.job_name?.trim() || r.site_address?.trim() || 'Untitled run'
              const subAddress = r.job_name?.trim() && r.site_address?.trim() ? r.site_address.trim() : null
              return (
                <li key={r.id} className="flex items-stretch">
                  <button
                    type="button"
                    disabled={extracting || pricing || saving}
                    aria-busy={extracting || pricing || saving}
                    onClick={() => void loadRun(r.id)}
                    aria-current={isActive ? 'true' : undefined}
                    className={`group flex w-full min-w-0 flex-1 cursor-pointer items-center gap-4 border-l-2 px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 ${
                      isActive
                        ? 'border-l-accent bg-accent/10 hover:bg-accent/20'
                        : 'border-l-transparent bg-ink-deep hover:border-l-accent/50 hover:bg-ink'
                    }`}
                  >
                    {/* Status gutter — fixed width so the job names line up. */}
                    <span className="flex w-24 shrink-0 sm:w-28">
                      <StatusPill label={meta.label} tone={meta.tone} dot compact pulse={meta.pulse} />
                    </span>

                    {/* Job identity. */}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-text-pri">{title}</span>
                        {isActive && (
                          <span className="shrink-0 text-[0.55rem] font-semibold uppercase tracking-[0.08em] text-accent">
                            Current
                          </span>
                        )}
                      </span>
                      <span className={`mt-0.5 flex items-center gap-1.5 text-[0.7rem] ${isActive ? 'text-text-sec' : 'text-text-dim'}`}>
                        {subAddress && (
                          <>
                            <span className="truncate">{subAddress}</span>
                            <span aria-hidden>·</span>
                          </>
                        )}
                        <span className="shrink-0 uppercase tracking-[0.08em]">
                          {new Date(r.created_at).toLocaleDateString('en-AU', {
                            day: '2-digit',
                            month: 'short',
                            year: '2-digit',
                          })}
                        </span>
                      </span>
                    </span>

                    {/* Open affordance — replaces the old, misleading refresh icon. */}
                    <span className="flex shrink-0 items-center gap-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.08em] text-text-dim transition-colors group-hover:text-accent">
                      <span className="hidden sm:inline">{isActive ? 'Reload' : 'Open'}</span>
                      <ChevronRight
                        className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                        aria-hidden
                      />
                    </span>
                  </button>
                  {/* Customer tender page — sibling anchor (never nested in the
                      row button) so keyboard users get both targets. Mirrors
                      the button's resting/active/disabled painting so the row
                      reads as one piece edge to edge. */}
                  {r.public_token && (
                    <a
                      href={`/q/commercial-paint/${r.public_token}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-disabled={extracting || pricing || saving ? 'true' : undefined}
                      className={`flex shrink-0 items-center border-l border-ink-line px-4 text-[0.62rem] font-semibold uppercase tracking-[0.08em] transition-colors hover:text-text-pri ${
 isActive ? 'bg-accent/10 text-text-sec' : 'bg-ink-deep text-text-dim'
 } ${extracting || pricing || saving ? 'pointer-events-none opacity-50' : ''}`}
                    >
                      Customer →
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
          <PaginationControls
            page={runPage}
            totalPages={runTotalPages}
            onPageChange={setRunPage}
            startIndex={runStart}
            endIndex={runEnd}
            total={runTotal}
            unit="runs"
          />
        </section>
      )}
      </fieldset>
    </div>
  )
}

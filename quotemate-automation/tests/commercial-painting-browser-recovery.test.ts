import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PAINT_CORRECTION_BODY_LIMIT, paintCorrectionRequestText, type PaintCorrectionInput } from '../lib/commercial-painting/correction-contract'
import type { PaintCorrectionCopy } from '../lib/commercial-painting/browser-correction-receipt'
import { paintSaveReceiptKey } from '../lib/commercial-painting/browser-save-receipt'

const scope = { userId: 'user_a', tenantId: '10000000-0000-4000-8000-000000000001' }
const pass = { paintRunId: '20000000-0000-4000-8000-000000000001', extractionId: '30000000-0000-4000-8000-000000000001', pricingProof: 'a'.repeat(64), pricedAt: '2026-09-09T10:00:00.000001Z' }
const key = paintSaveReceiptKey(scope)
const saved = { ok: true, ...pass, quoteId: '40000000-0000-4000-8000-000000000001', shareToken: 'saved_quote_token', quoteViewUrl: '/q/saved_quote_token', pdfUrl: null, delivery: { attempted: false } }
const run = { id: pass.paintRunId, job_name: 'Offline paint fixture', site_address: 'Sample site', status: 'priced', created_at: '2026-09-09T00:00:00Z', public_token: null }
const takeoffItem = { surface: 'Walls', room: 'Main', substrate: 'plasterboard', system: 'low_sheen', unit: 'm2', quantity: 20, coats: 2, confidence: 'high', source: 'manual' }
let browser: Browser, server: Server, origin: string
const contexts: BrowserContext[] = []
beforeAll(async () => {
  const bundled = await build({ stdin: { contents: `import {browserPaintCorrectionStore} from './lib/commercial-painting/browser-correction-receipt'; window.__readCorrection=(scope)=>browserPaintCorrectionStore(scope).read(); import React from 'react'; import {createRoot} from 'react-dom/client'; import Tab from './app/dashboard/_components/commercial-painting/CommercialPaintingTab'; window.__user='user_a';window.__listeners=new Set();window.__setUser=(id)=>{window.__user=id;window.__listeners.forEach(fn=>fn())};const root=createRoot(document.getElementById('app'));root.render(<Tab accessToken="fixture-session"/>);`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'offline-outer-boundaries', setup(plugin) {
      plugin.onResolve({ filter: /^@clerk\/nextjs$|^@\/lib\/auth\/client-token$|PlanOverlay$|PaintPricedSummary$|EstimatorChatbot$|PaintPreviewPanel$|Pagination$|quote-ui$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => {
        let contents: string
        if (args.path === '@clerk/nextjs') contents = `import {useSyncExternalStore} from 'react';export function useAuth(){const userId=useSyncExternalStore(fn=>{window.__listeners.add(fn);return()=>window.__listeners.delete(fn)},()=>window.__user);return{userId,isLoaded:true}}`
        else if (args.path.endsWith('client-token')) contents = `export async function getAuthToken(){return window.__user?'token:'+window.__user:null}`
        else if (args.path.endsWith('Pagination')) contents = `export function usePagination(items){return {page:1,setPage:()=>{},totalPages:1,pageItems:items,startIndex:0,endIndex:items.length,total:items.length}}export function PaginationControls(){return null}`
        else if (args.path.endsWith('quote-ui')) contents = `export function StatusPill({label}){return <span>{label}</span>}`
        else if (args.path.endsWith('EstimatorChatbot')) contents = `export default function Chat(){return null}`
        else contents = `export function ${args.path.split('/').pop()}(){return null}`
        return { contents, loader: 'tsx', resolveDir: process.cwd() }
      })
      plugin.onResolve({ filter: /^@\// }, args => ({ path: path.resolve(process.cwd(), args.path.slice(2)) + '.ts' }))
    } }],
  })
  const js = bundled.outputFiles[0].text
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js) }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><div id="app"></div><script src="/fixture.js"></script>') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  browser = await chromium.launch({ headless: true })
}, 60000)
afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())) })
afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())) })

async function fixture() {
  const context = await browser.newContext(); contexts.push(context)
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const state = { posts: [] as Record<string, unknown>[], getCount: 0, receiptAtPost: null as string | null, response: 'lost', error: 'saved_quote_unverifiable', recovery: 'not_found', unexpected: [] as string[], errors: [] as string[], release: null as (() => void) | null,
    correctionPosts: [] as PaintCorrectionInput[], correctionGets: 0, correctionResponse: 'saved', correctionRecovery: 'not_found', runItems: [takeoffItem],
    correctionResult: null as Record<string, unknown> | null, retainedAtPost: null as PaintCorrectionCopy | null,
    snapshot: { runId: run.id, extractionId: pass.extractionId, revision: 'b'.repeat(64), job_name: run.job_name, site_address: run.site_address,
      items: [takeoffItem], corrected_items: null as typeof takeoffItem[] | null, released: false } }
  page.on('pageerror', e => state.errors.push(e.message))
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method()
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname.endsWith('/save-quote') && url.searchParams.get('scope') === '1') {
      const userId = request.headers().authorization?.slice('Bearer token:'.length)
      return json({ ok: true, userId, tenantId: userId === scope.userId ? scope.tenantId : '10000000-0000-4000-8000-000000000002' })
    }
    if (url.pathname.endsWith('/runs')) return json({ ok: true, runs: [run] })
    if (url.pathname.endsWith(`/run/${run.id}/corrections`)) {
      if (method === 'GET') {
        if (!url.searchParams.has('operationId')) return json({ ok: true, snapshot: state.snapshot })
        state.correctionGets += 1
        return json(state.correctionRecovery === 'saved' && state.correctionResult ? state.correctionResult :
          { ok: true, status: 'not_found', runId: run.id, operationId: url.searchParams.get('operationId') })
      }
      const input = request.postDataJSON() as PaintCorrectionInput; state.correctionPosts.push(input)
      try { state.retainedAtPost = await correctionCopy(page) }
      catch { await route.abort('aborted').catch(() => {}); return }
      if (state.correctionResponse === 'conflict') return json({ ok: false, error: 'correction_conflict' }, 409)
      if (state.correctionResponse === 'lostAbsent') return route.abort('failed')
      if (state.correctionResponse === 'held') await new Promise<void>(resolve => { state.release = resolve })
      state.snapshot = { ...state.snapshot, revision: 'c'.repeat(64), job_name: input.job_name ?? state.snapshot.job_name,
        site_address: input.site_address ?? state.snapshot.site_address, corrected_items: input.corrected_items as typeof takeoffItem[] ?? state.snapshot.corrected_items }
      state.correctionResult = { ok: true, status: 'applied', runId: run.id, operationId: input.operationId, extractionId: input.extractionId,
        expectedRevision: input.expectedRevision, requestHash: createHash('sha256').update(paintCorrectionRequestText(input)).digest('hex'), revision: state.snapshot.revision }
      if (state.correctionResponse === 'lostApplied') return route.abort('failed')
      return json(state.correctionResponse === 'foreign' ? { ...state.correctionResult, operationId: '50000000-0000-4000-8000-000000000001' } : state.correctionResult)
    }
    if (url.pathname.endsWith(`/run/${run.id}`)) return json(method === 'PATCH' ? { ok: true } : { ok: true, run, uploads: [], extraction: { id: pass.extractionId,
      items: state.runItems, corrected_items: null, sheets_used: {}, priced_bom: { labour: { ratePerHr: 90 } }, pricing_review: { pricingProof: pass.pricingProof, pricedAt: pass.pricedAt } } })
    if (url.pathname.endsWith('/price')) {
      expect(request.postDataJSON().expectedRevision).toBe(state.snapshot.revision)
      return json({ ok: true, bom: { labour: { ratePerHr: 90 } }, pricingProof: pass.pricingProof, pricedAt: pass.pricedAt })
    }
    if (url.pathname.endsWith('/save-quote') && method === 'POST') {
      state.posts.push(request.postDataJSON()); state.receiptAtPost = await page.evaluate(key => localStorage.getItem(key), key)
      if (state.response === 'lost') return route.abort('failed')
      if (state.response === 'rejected') return json({ ok: false, error: state.error }, state.error === 'invalid_pricing' ? 422 : 409)
      if (state.response === 'held') await new Promise<void>(resolve => { state.release = resolve })
      return json(saved)
    }
    if (url.pathname.endsWith('/save-quote') && method === 'GET') {
      state.getCount += 1
      if (state.recovery === 'saved') return json({ ...saved, status: 'saved' })
      if (state.recovery === 'foreign') return json({ ...saved, status: 'saved', pricedAt: '2026-09-09T10:00:00.000002Z' })
      return json({ ok: true, ...pass, status: 'not_found' })
    }
    state.unexpected.push(`${method} ${url.pathname}`); return route.abort('blockedbyclient')
  })
  await page.goto(origin)
  await page.getByRole('button', { name: /Offline paint fixture/ }).waitFor()
  return { context, page, state }
}
async function openPriced(page: Page) { await page.getByRole('button', { name: /Offline paint fixture/ }).click(); await page.getByRole('button', { name: 'Save as quote', exact: true }).waitFor() }
async function receipt(page: Page) { return page.evaluate(key => localStorage.getItem(key), key) }
async function correctionCopy(page: Page) { return page.evaluate(async owner => (window as unknown as {
  __readCorrection: (scope: typeof owner) => Promise<PaintCorrectionCopy | null> }).__readCorrection(owner), scope) }
describe('commercial painting actual browser orchestration with offline HTTP boundaries', () => {
  it('does not attach the first GET old price to a corrected source in the second GET', async () => {
    const { page, state } = await fixture()
    state.snapshot.corrected_items = [{ ...takeoffItem, quantity: 99 }]
    state.snapshot.revision = 'd'.repeat(64)
    await page.getByRole('button', { name: /Offline paint fixture/ }).click()
    await page.getByText(/The saved takeoff changed while opening this run/).waitFor()
    expect(await page.getByLabel('Quantity', { exact: true }).inputValue()).toBe('99')
    expect(await page.getByRole('button', { name: 'Save as quote', exact: true }).count()).toBe(0)
    expect(state.posts).toHaveLength(0); expect(state.correctionPosts).toHaveLength(0)
  })
  it('does not claim a correction was saved when its metadata fails validation before storage or POST', async () => {
    const { page, state } = await fixture(); await openPriced(page)
    await page.getByPlaceholder('IGA Swan Street fit-out').fill('x'.repeat(201))
    await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).click()
    await page.getByText(/The correction was not confirmed saved/).waitFor()
    expect(state.correctionPosts).toHaveLength(0); expect(await correctionCopy(page)).toBeNull()
    expect(await page.getByPlaceholder('IGA Swan Street fit-out').inputValue()).toHaveLength(201)
  })
  it('holds a valid Unicode-heavy request in the editor before any receipt or POST exceeds the hosting limit', async () => {
    const { page, state } = await fixture()
    page.setDefaultTimeout(15000)
    const large = Array.from({ length: 1510 }, () => ({ ...takeoffItem, surface: '界'.repeat(200), room: '界'.repeat(120),
      substrate: '界'.repeat(120), note: '界'.repeat(400) }))
    const actualRequest = { operationId: '50000000-0000-4000-8000-000000000001', expectedRevision: state.snapshot.revision,
      extractionId: pass.extractionId, job_name: run.job_name, site_address: run.site_address, corrected_items: large }
    expect(Buffer.byteLength(JSON.stringify(actualRequest), 'utf8')).toBeGreaterThan(PAINT_CORRECTION_BODY_LIMIT)
    state.runItems = large; state.snapshot.items = large
    await openPriced(page)
    await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).click()
    await page.getByText(/These corrections exceed the 4 MB request limit/).waitFor()
    expect(state.correctionPosts).toHaveLength(0); expect(await correctionCopy(page)).toBeNull()
    expect(await page.getByLabel('Quantity', { exact: true }).count()).toBe(1510)
    expect(await page.getByLabel('Quantity', { exact: true }).first().isEnabled()).toBe(true)
  }, 30000)
  it('retains the actual observed baseline and encrypted working copy before correction POST, including zero rows', async () => {
    const { page, state } = await fixture(); await openPriced(page)
    await page.getByLabel('Quantity', { exact: true }).fill('0')
    await page.getByLabel('Labour rate in dollars per hour').fill('112')
    await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).click()
    await expect.poll(() => state.correctionPosts.length).toBe(1)
    await expect.poll(() => correctionCopy(page)).toBeNull()
    expect(state.correctionPosts[0]).toMatchObject({ expectedRevision: 'b'.repeat(64), extractionId: pass.extractionId,
      corrected_items: [{ ...takeoffItem, quantity: 0 }] })
    expect(state.retainedAtPost).toMatchObject({ attempts: 1, labourRatePerHr: 112, input: state.correctionPosts[0] })
    expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([])
  })
  it('keeps a lost correction and working copy across reload, recovers by GET only, then explicitly reviews saved data', async () => {
    const { page, state } = await fixture(); await openPriced(page); state.correctionResponse = 'lostApplied'
    await page.getByLabel('Quantity', { exact: true }).fill('123')
    await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).click()
    await page.getByRole('button', { name: 'Check previous correction' }).waitFor()
    const envelope = await page.evaluate(async () => {
      const open = indexedDB.open('quotemax.paint-correction.v1')
      const database = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
      try {
        const read = database.transaction('copies').objectStore('copies').getAll()
        const rows = await new Promise<Array<{ key: CryptoKey; bytes: ArrayBuffer }>>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error) })
        return { extractable: rows[0].key.extractable, type: rows[0].key.type, plaintext: new TextDecoder().decode(rows[0].bytes) }
      } finally { database.close() }
    })
    expect(envelope.extractable).toBe(false); expect(envelope.type).toBe('secret'); expect(envelope.plaintext).not.toContain('Walls')
    await expect.poll(() => state.correctionResult).not.toBeNull()
    state.correctionRecovery = 'saved'; await page.reload()
    await page.getByRole('button', { name: 'Review saved corrections' }).waitFor()
    expect(state.correctionPosts).toHaveLength(1); expect(state.correctionGets).toBe(1)
    expect((await correctionCopy(page))?.input.corrected_items?.[0].quantity).toBe(123)
    await page.getByRole('button', { name: 'Review saved corrections' }).click()
    await expect.poll(() => correctionCopy(page)).toBeNull()
    expect(await page.getByLabel('Quantity', { exact: true }).inputValue()).toBe('123')
  })
  it('retries an absent correction only on explicit action with identical ID, baseline and input', async () => {
    const { page, state } = await fixture(); await openPriced(page); state.correctionResponse = 'lostAbsent'
    await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).click()
    await page.getByText(/Saving corrections could not be confirmed/).waitFor(); await page.reload()
    await page.getByText(/No correction result is visible yet/).waitFor()
    expect(state.correctionPosts).toHaveLength(1)
    state.correctionResponse = 'saved'; await page.getByRole('button', { name: 'Retry exact correction' }).click()
    await page.getByRole('button', { name: 'Review saved corrections' }).waitFor()
    expect(state.correctionPosts[1]).toEqual(state.correctionPosts[0]); expect(state.correctionPosts).toHaveLength(2)
  })
  it('preserves a stale rejected working copy across reload and never silently changes its baseline', async () => {
    const { page, state } = await fixture(); await openPriced(page); state.correctionResponse = 'conflict'
    await page.getByLabel('Quantity', { exact: true }).fill('77')
    await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).click()
    await page.getByRole('button', { name: 'Discard retained copy and reload latest saved data' }).waitFor()
    await page.reload(); await page.getByRole('button', { name: 'Discard retained copy and reload latest saved data' }).waitFor()
    expect(await correctionCopy(page)).toMatchObject({ rejected: true, input: { expectedRevision: 'b'.repeat(64), corrected_items: [{ ...takeoffItem, quantity: 77 }] } })
    expect(state.correctionPosts).toHaveLength(1); expect(state.correctionGets).toBe(0)
  })
  it('blocks invalid coats without dropping edited rows and blocks POST on encrypted storage failure', async () => {
    const { page, state } = await fixture(); await openPriced(page)
    await page.getByLabel('Coats', { exact: true }).fill('6'); await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).click()
    await page.getByText(/No rows have been removed/).waitFor(); expect(state.correctionPosts).toHaveLength(0)
    await page.getByLabel('Coats', { exact: true }).fill('4')
    await page.evaluate(() => { IDBFactory.prototype.open = () => { throw new Error('Unavailable') } })
    await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).click()
    await page.getByRole('button', { name: 'Check correction storage' }).waitFor(); expect(state.correctionPosts).toHaveLength(0)
  })
  it('fences an old-account late correction success and preserves its encrypted recovery copy', async () => {
    const { page, state } = await fixture(); await openPriced(page); state.correctionResponse = 'held'
    await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).click()
    await expect.poll(() => state.release !== null).toBe(true)
    await page.evaluate(() => (window as unknown as { __setUser: (id: string) => void }).__setUser('user_b'))
    await page.getByRole('button', { name: /Offline paint fixture/ }).waitFor()
    const reply = page.waitForResponse(response => response.url().endsWith('/corrections') && response.request().method() === 'POST')
    state.release!(); await reply
    expect(await correctionCopy(page)).not.toBeNull()
    expect(await page.getByRole('button', { name: 'Review saved corrections' }).count()).toBe(0)
  })
  it('stores opaque proof before POST and recovers a lost response after reload with GET only', async () => {
    const { page, state } = await fixture(); await openPriced(page)
    await page.getByPlaceholder('Customer name (optional)').fill('Private Customer')
    await page.getByPlaceholder('Customer mobile e.g. 0412 345 678').fill('0400000000')
    await page.getByRole('button', { name: 'Save as quote', exact: true }).click()
    await page.getByRole('button', { name: 'Check previous save' }).waitFor()
    // The recovery button appears before the intercepted POST's async capture finishes.
    await expect.poll(() => state.receiptAtPost).not.toBeNull()
    expect(state.posts).toEqual([{ ...pass, customerName: 'Private Customer', customerPhone: '0400000000' }])
    expect(JSON.parse(state.receiptAtPost!)).toEqual({ version: 1, scope, pass })
    state.recovery = 'saved'; await page.reload()
    await page.getByRole('link', { name: 'Open saved quote' }).waitFor()
    expect(state.posts).toHaveLength(1); expect(state.getCount).toBe(1); expect(await receipt(page)).toBeNull()
    expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([])
  })
  it('keeps an absent or foreign result and blocks new calculation from erasing it', async () => {
    const { page, state } = await fixture(); await openPriced(page)
    await page.getByRole('button', { name: 'Save as quote', exact: true }).click()
    await page.getByRole('button', { name: 'Check previous save' }).waitFor()
    await page.getByRole('button', { name: 'Check previous save' }).click()
    await page.getByText(/No saved result is visible yet/).waitFor()
    expect(await page.getByRole('button', { name: 'New run', exact: true }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).isDisabled()).toBe(true)
    state.recovery = 'foreign'; await page.getByRole('button', { name: 'Check previous save' }).click()
    await page.getByText(/does not match the reviewed pricing pass/).waitFor()
    expect(await receipt(page)).not.toBeNull(); expect(state.posts).toHaveLength(1)
  })
  it('does not POST when recovery storage fails', async () => {
    const { page, state } = await fixture(); await openPriced(page)
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Storage unavailable') } })
    await page.getByRole('button', { name: 'Save as quote', exact: true }).click()
    await page.getByText('Storage unavailable', { exact: true }).waitFor()
    expect(state.posts).toHaveLength(0)
  })
  it.each(['released_quote_immutable', 'invalid_pricing'])('clears only an initial conclusively rejected %s save', async error => {
    const { page, state } = await fixture(); state.response = 'rejected'; state.error = error; await openPriced(page)
    await page.getByRole('button', { name: 'Save as quote', exact: true }).click()
    await page.getByText(/The save was rejected before a quote was created/).waitFor()
    expect(await receipt(page)).toBeNull(); expect(state.posts).toHaveLength(1)
    expect(await page.getByRole('button', { name: 'Confirm takeoff & price', exact: true }).isDisabled()).toBe(false)
  })
  it('retains a post-commit unverifiable result and isolates it after switching account', async () => {
    const { page, state } = await fixture(); state.response = 'rejected'; await openPriced(page)
    await page.getByRole('button', { name: 'Save as quote', exact: true }).click()
    await page.getByRole('button', { name: 'Check previous save' }).waitFor()
    expect(await receipt(page)).not.toBeNull()
    await page.evaluate(() => (window as unknown as { __setUser: (id: string) => void }).__setUser('user_b'))
    await page.getByRole('button', { name: /Offline paint fixture/ }).waitFor()
    expect(await page.getByRole('button', { name: 'Check previous save' }).count()).toBe(0)
    expect(await receipt(page)).not.toBeNull(); expect(state.getCount).toBe(0)
  })
  it('does not clear an old account receipt or display its late success after switching identity', async () => {
    const { page, state } = await fixture(); state.response = 'held'; await openPriced(page)
    await page.getByRole('button', { name: 'Save as quote', exact: true }).click()
    await expect.poll(() => state.release !== null).toBe(true)
    await page.evaluate(() => (window as unknown as { __setUser: (id: string) => void }).__setUser('user_b'))
    await page.getByRole('button', { name: /Offline paint fixture/ }).waitFor()
    const response = page.waitForResponse(res => res.url().endsWith('/save-quote') && res.request().method() === 'POST')
    state.release!(); await response
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await receipt(page)).not.toBeNull()
    expect(await page.getByRole('link', { name: 'Open saved quote' }).count()).toBe(0)
    expect(state.posts).toHaveLength(1)
  })
})

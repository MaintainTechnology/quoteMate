/** Offline browser contracts for the actual recovery/review client components.
 * Auth token acquisition, API I/O and Next Link are adapters. No live auth,
 * database, carrier or pricing calls are made. This is not deployed E2E proof.
 * Run: node scripts/test-sms-recovery-ui.mjs --out=<evidence-directory>
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('tsx/package.json'))('esbuild')
const output = process.argv.find(arg => arg.startsWith('--out='))?.slice(6)
const components = ['sms-delivery', 'sms-recovery', 'quote-review']
const bundle = await build({
  stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';
    ${components.map((name, i) => `import Page${i} from './app/dashboard/${name}/page';`).join('\n')}
    import SendQuotePanel from './app/dashboard/quote/[token]/SendQuotePanel';
    import {ApproveAction} from './app/q/[token]/approve/ApproveAction';
    const phone=new URLSearchParams(location.search).get('phone')||'+61400111222';
    const pages={${components.map((name, i) => `'${name}':Page${i}`).join(',')},
      'generic-send':()=> <div style={{padding:24}}><SendQuotePanel quoteId="saved-quote" reviewVersion="reviewed-revision" sentBefore={true} customerPhone={phone} customerEmail="customer@example.com" paid={false}/></div>,
      'generic-approve':()=> <div style={{padding:24}}><p>Send customer SMS to {phone}</p><ApproveAction quoteId="saved-quote" shareToken="saved-token" reviewVersion="reviewed-revision" customerPhone={phone}/></div>};
    const Page=pages[location.pathname.split('/').pop()];createRoot(document.getElementById('root')).render(<Page/>);`,
  resolveDir: root, loader: 'tsx' },
  absWorkingDir: root, bundle: true, write: false, platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'offline-ui-boundaries', setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/auth\/client-token$/ }, () => ({ path: 'auth', namespace: 'offline' }))
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'offline' }))
    builder.onLoad({ filter: /.*/, namespace: 'offline' }, args => ({
      contents: args.path === 'auth' ? 'export async function getAuthToken(){return "offline-owner-token"}'
        : 'import React from "react";export default function Link(props){return React.createElement("a",props)}',
      loader: 'js', resolveDir: root,
    }))
  } }],
})
const css = (await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, 'app/globals.css'), 'utf8'), {
  from: path.join(root, 'app/globals.css'),
})).css
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle.outputFiles[0].contents) }
  else if (request.url === '/style.css') { response.setHeader('Content-Type', 'text/css'); response.end(css) }
  else if (request.url.startsWith('/api/')) { response.writeHead(500); response.end('Unmocked API blocked') }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html lang="en-AU" data-theme="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
let browser
const checks = []
try {
  if (output) await mkdir(output, { recursive: true })
  browser = await chromium.launch({ headless: true })
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-AU' })
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const posts = []
    const now = '2026-09-08T09:00:00Z'
    let retryQueued = false
    await page.route('**/api/tenant/sms-delivery', async route => {
      expect(route.request().headers().authorization).toBe('Bearer offline-owner-token')
      if (route.request().method() === 'POST') {
        posts.push(route.request().postDataJSON()); retryQueued = true
        return route.fulfill({ json: { ok: true } })
      }
      return route.fulfill({ json: { messages: [
        { id: 'failed', status: retryQueued ? 'queued' : 'failed', provider_error: '30003' },
        { id: 'ambiguous', status: 'unknown', provider_error: null },
        { id: 'opted-out', status: 'undelivered', provider_error: '21610' },
      ].map(message => ({ ...message, body: 'Saved quote notification', to_number: '+61400111222', audience: 'customer', requires_attention: true, created_at: now })) } })
    })
    await page.goto(`${origin}/dashboard/sms-delivery`)
    await expect(page.getByRole('button', { name: 'Retry this message' })).toHaveCount(1)
    await expect(page.getByText('unknown', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Retry this message' }).click()
    await expect(page.getByRole('status')).toContainText('queued for another delivery attempt')
    expect(posts).toEqual([{ id: 'failed' }])
    await expect(page.getByRole('button', { name: 'Retry this message' })).toHaveCount(0)
    checks.push({ width, case: 'delivery preserves unknown/opt-out and retries only a known failure', passed: true })
    if (output && width === 390) await page.screenshot({ path: path.join(output, 'sms-delivery-mobile.png'), fullPage: true })

    let resumed = false
    await page.route('**/api/tenant/sms-recovery', async route => {
      expect(route.request().headers().authorization).toBe('Bearer offline-owner-token')
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON()).toEqual({ id: 'recoverable', action: 'retry' }); resumed = true
        return route.fulfill({ json: { ok: true } })
      }
      return route.fulfill({ json: { tasks: [{ id: 'review', trade: 'roofing', reason: 'Saved estimate needs review', status: 'open', customer_phone: '+61400111222', notification_error: 'owner_unavailable', resource_type: 'roof', resource_id: 'saved-roof' }],
        jobs: [{ id: 'retired', service_key: 'retired-platform' }, { id: 'recoverable', service_key: 'electrical' }].map(job => ({ ...job, kind: 'inbound', status: resumed && job.id === 'recoverable' ? 'pending' : 'failed', created_at: now })) } })
    })
    await page.goto(`${origin}/dashboard/sms-recovery`)
    await expect(page.getByRole('button', { name: 'Resume this enquiry' })).toHaveCount(1)
    await expect(page.getByText('Owner notification needs attention')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Review saved quote' })).toHaveAttribute('href', '/dashboard/quote-review?family=roof&id=saved-roof')
    await page.getByRole('button', { name: 'Resume this enquiry' }).click()
    await expect(page.getByRole('status')).toContainText('resume from its saved progress')
    await expect(page.getByRole('button', { name: 'Resume this enquiry' })).toHaveCount(0)
    checks.push({ width, case: 'recovery offers real queued retry, owner attention and retired-route support', passed: true })
    if (output && width === 390) await page.screenshot({ path: path.join(output, 'sms-recovery-mobile.png'), fullPage: true })

    let stale = true
    let version = 'saved-version-1'
    const reviewPosts = []
    await page.route('**/api/sms/quote-release*', async route => {
      expect(route.request().headers().authorization).toBe('Bearer offline-owner-token')
      if (route.request().method() === 'POST') {
        reviewPosts.push(route.request().postDataJSON())
        return stale ? route.fulfill({ status: 409, json: { error: 'Saved result changed. Refresh and review again.' } })
          : route.fulfill({ status: 202, json: { accepted: false } })
      }
      return route.fulfill({ json: { review: { family: 'roof', id: 'saved-roof', version, customerPhone: '+61400111222', address: '1 Test Street, Sydney', approved: false, canApprove: true, createdAt: now,
        amounts: [{ label: 'Saved option', incGst: 1100 }], scope: ['Replace the damaged roof area using the saved measurements.'], quantities: [{ label: 'Roof area', quantity: '10 square metres' }], warnings: ['Check access before approval.'] } } })
    })
    await page.goto(`${origin}/dashboard/quote-review?family=roof&id=saved-roof`)
    const approve = page.getByRole('button', { name: 'Approve and send saved result' })
    await expect(page.getByText('$1,100.00', { exact: true })).toBeVisible()
    await expect(approve).toBeDisabled()
    await expect(page.getByLabel('Customer mobile', { exact: true })).toHaveAttribute('readonly', '')
    await page.getByRole('checkbox').check()
    expect(await approve.evaluate(button => getComputedStyle(button).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    await approve.click()
    await expect(page.getByRole('status')).toContainText('Saved result changed')
    expect(reviewPosts[0]).toEqual({ family: 'roof', id: 'saved-roof', customerPhone: '+61400111222', approve: true, reviewVersion: 'saved-version-1' })
    version = 'saved-version-2'; stale = false
    await page.getByRole('button', { name: 'Refresh saved result' }).click()
    await expect(page.getByRole('checkbox')).not.toBeChecked()
    await expect(approve).toBeDisabled()
    if (output && width === 390) await page.screenshot({ path: path.join(output, 'sms-review-mobile.png'), fullPage: true })
    await page.getByRole('checkbox').check()
    await approve.click()
    await expect(page.getByRole('status')).toContainText('not been confirmed as received')
    await expect(approve).toBeDisabled()
    expect(reviewPosts[1].reviewVersion).toBe('saved-version-2')
    checks.push({ width, case: 'review requires consent and displayed version, handles stale review and uncertain delivery', passed: true })

    const genericPosts = []
    let genericMode = 'changed'
    await page.route('**/api/quote/saved-quote/send', async route => {
      expect(route.request().headers().authorization).toBe('Bearer offline-owner-token')
      genericPosts.push(route.request().postDataJSON())
      if (genericMode === 'lost') { genericMode = 'accepted'; return route.abort('failed') }
      return genericMode === 'changed' ? route.fulfill({ status: 409, json: { error: 'quote_recipient_changed' } })
        : route.fulfill({ json: { ok: true, accepted: true } })
    })
    await page.goto(`${origin}/dashboard/generic-send`)
    await page.getByRole('button', { name: 'Send to Customer', exact: true }).click()
    await expect(page.getByText('+61400111222', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Send SMS', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send SMS', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Refresh and review contact' })).toHaveCount(1)
    expect(genericPosts[0]).toMatchObject({ channel: 'sms', expected_recipient: '+61400111222', expected_revision: 'reviewed-revision' })
    expect(genericPosts[0].to).toBeUndefined()
    expect(genericPosts[0].requestId).toMatch(/^[0-9a-f-]{36}$/)
    await page.getByRole('button', { name: 'Send Email', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Send Email', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Refresh and review contact' })).toHaveCount(2)
    expect(genericPosts[1]).toMatchObject({ channel: 'email', expected_recipient: 'customer@example.com' })
    expect(genericPosts).toHaveLength(2)
    if (output && width === 390) await page.screenshot({ path: path.join(output, 'sms-recipient-review-mobile.png'), fullPage: true })
    checks.push({ width, case: 'generic SMS and email bind displayed recipients and require deliberate refresh after conflict', passed: true })

    genericMode = 'lost'
    await page.goto(`${origin}/dashboard/generic-send`)
    await page.getByRole('button', { name: 'Send to Customer', exact: true }).click()
    await page.getByRole('button', { name: 'Send SMS', exact: true }).click()
    await expect(page.getByText('Send response was lost.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Send SMS', exact: true }).click()
    await expect(page.getByText('SMS accepted by carrier.', { exact: true })).toBeVisible()
    expect(genericPosts).toHaveLength(4)
    expect(genericPosts[3]).toEqual(genericPosts[2])
    checks.push({ width, case: 'generic lost-response SMS retry keeps its original UUID, revision and recipient', passed: true })

    const approvalPosts = []
    await page.route('**/api/quote/saved-quote/approve', async route => {
      expect(route.request().headers().authorization).toBe('Bearer offline-owner-token')
      approvalPosts.push(route.request().postDataJSON())
      return route.fulfill({ status: 409, json: { error: 'quote_recipient_changed' } })
    })
    await page.goto(`${origin}/dashboard/generic-approve`)
    await page.getByRole('button', { name: 'Send now →' }).click()
    await expect(page.getByRole('button', { name: 'Send now →' })).toBeDisabled()
    await expect(page.getByRole('link', { name: 'Refresh and review contact' })).toHaveAttribute('href', '/q/saved-token/approve')
    expect(approvalPosts).toEqual([{ expected_revision: 'reviewed-revision', expected_recipient: '+61400111222' }])
    checks.push({ width, case: 'generic approval submits its reviewed phone and blocks automatic retry after a contact conflict', passed: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(errors).toEqual([])
    checks.push({ width, case: 'browser has no client exception or horizontal overflow', passed: true })
    await context.close()
  }
  const sourceHashes = Object.fromEntries(await Promise.all(components.map(async name => [name, createHash('sha256').update(await readFile(path.join(root, `app/dashboard/${name}/page.tsx`))).digest('hex')])))
  for (const file of ['app/dashboard/quote/[token]/SendQuotePanel.tsx', 'app/q/[token]/approve/ApproveAction.tsx']) sourceHashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')
  const result = { boundary: 'actual client components; offline auth/API/Link adapters; not deployed E2E', checks, sourceHashes }
  if (output) await writeFile(path.join(output, 'sms-recovery-ui.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally {
  if (browser) await browser.close()
  await new Promise(resolve => server.close(resolve))
}

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

// ════════════════════════════════════════════════════════════════════
// WIRING INVARIANT for POST /api/estimate/draft and POST /api/intake/structure.
//
// Both routes mint Stripe sessions and text customers, and until now both
// accepted anonymous calls (proxy.ts:20 is a bare clerkMiddleware() that never
// gates). The guard is isCronAuthorised, which is FAIL-CLOSED in production
// (lib/agents/cron.ts:31) — so the dangerous failure mode is not "the guard is
// wrong", it is "a caller shipped without the header". That takes every intake
// channel offline at once: voice, SMS, flyer-QR web leads and the dashboard
// job-quote form, three of which then text the customer a failure message.
//
// The route modules cannot be imported here: each calls createClient() at
// module scope and vitest.config.ts injects no env, so the import throws on an
// undefined Supabase URL. The helper itself is covered by lib/agents/cron.test.ts
// (11 tests). What is NOT otherwise covered — and what actually breaks
// production — is the wiring, so this asserts it at the source level.
// ════════════════════════════════════════════════════════════════════

const ROOT = resolve(__dirname, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

/** The two routes that must reject an unauthorised caller. */
const GUARDED_ROUTES = [
  'app/api/estimate/draft/route.ts',
  'app/api/intake/structure/route.ts',
] as const

/** Every in-app caller of those routes. scripts/ is excluded deliberately:
 *  isCronAuthorised is header-optional off production, so a dev script keeps
 *  working without a secret. */
const CALLERS = [
  'app/api/vapi/webhook/route.ts',
  'app/api/q/choose/[token]/route.ts',
  'app/api/t/[slug]/lead/route.ts',
  'app/api/tenant/job-quote/route.ts',
  // The self-serve quote-request form behind /quote-request/<token> — it hands
  // the submitted brief to /api/intake/structure. Registered here so the header
  // assertions below hold it to the same contract as every other caller; it
  // already sends `Bearer ${CRON_SECRET}` and this test is what keeps it that
  // way. (Shipped in 6bc5527b; the glob check caught it unregistered.)
  'app/api/quote-request/[token]/route.ts',
  // The customer photo-upload endpoint behind /upload/<token>. An SMS thread
  // that reached an identified job_type but has no intake yet is resumed by
  // handing the just-uploaded photos to /api/intake/structure — without the
  // header that resume 401s in production and the customer's photo never
  // produces a quote, which is the exact failure this glob check exists for.
  'app/api/upload/[token]/route.ts',
] as const

describe('guarded internal routes', () => {
  for (const file of GUARDED_ROUTES) {
    it(`${file} imports and calls isCronAuthorised`, () => {
      const src = read(file)
      expect(src, 'missing import').toMatch(/from '@\/lib\/agents\/cron'/)
      expect(src, 'missing guard call').toMatch(/isCronAuthorised\(\s*req\s*\)/)
    })

    it(`${file} returns 401 from the guard`, () => {
      const src = read(file)
      // The guard must early-return, not just log.
      expect(src).toMatch(/if\s*\(\s*!isCronAuthorised\(\s*req\s*\)\s*\)[\s\S]{0,120}401/)
    })

    it(`${file} guards BEFORE reading the body or writing anything`, () => {
      const src = read(file)
      const post = src.indexOf('export async function POST')
      expect(post, 'no POST handler found').toBeGreaterThan(-1)
      const guard = src.indexOf('isCronAuthorised', post)
      const firstRead = src.indexOf('await req.json()', post)
      expect(guard, 'guard not inside POST').toBeGreaterThan(post)
      expect(firstRead).toBeGreaterThan(-1)
      // A guard placed after req.json() would still work, but placing it first
      // keeps an unauthorised call from doing any parsing or registering any
      // after() work.
      expect(guard, 'guard must precede req.json()').toBeLessThan(firstRead)
    })
  }
})

// ── Behavioural: the guard actually rejects at runtime ──
// The source-level assertions above prove the guard is PRESENT. They cannot
// prove it FIRES — a guard wrapped in a flag, or with isCronAuthorised shadowed,
// would still match every regex. These import the real handlers and call them.
//
// Both route modules call createClient() at module scope and vitest injects no
// env, so Supabase is stubbed. Nothing else is faked: the guard, its helper and
// the 401 are the real code paths.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async (name: string) => ({ data: name === 'enqueue_sms_work' ? { id: '11111111-1111-4111-8111-111111111111', status: 'pending', kind: 'intake', turn_id: '11111111-1111-4111-8111-111111111111' } : [], error: null }),
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null }), maybeSingle: async () => ({ data: null }) }) }),
    }),
  }),
}))

describe('the guard rejects at runtime, not just in the source', () => {
  const handlers: Record<string, (req: Request) => Promise<Response>> = {}

  // 60s, not the 10s default: these two route modules transitively pull in the
  // whole estimator, Stripe, SMS, PDF and image-gen stack. ~3s alone, but past
  // 10s under full-suite load when every worker is competing — which is how this
  // passed in isolation and timed out in `vitest run`.
  beforeAll(async () => {
    // NODE_ENV is 'test' here, so isCronAuthorised takes its dev branch: a
    // no-header call is ALLOWED and a wrong-header call is rejected. Assert the
    // wrong-header case — it is the one that holds in every environment.
    process.env.CRON_SECRET = 'test-secret-value'
    handlers['draft'] = (await import('@/app/api/estimate/draft/route')).POST
    handlers['structure'] = (await import('@/app/api/intake/structure/route')).POST
  }, 60_000)

  const post = (body: unknown, auth?: string) =>
    new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: JSON.stringify(body),
    })

  for (const name of ['draft', 'structure'] as const) {
    it(`${name}: 401s a WRONG bearer`, async () => {
      const res = await handlers[name](post({ intakeId: 'x', callId: 'x' }, 'Bearer not-the-secret'))
      expect(res.status).toBe(401)
    })

    it(`${name}: does NOT 401 the correct bearer`, async () => {
      // Past the guard the handler fails on stubbed Supabase — any status but
      // 401 proves the guard let it through, which is all this asserts.
      const res = await handlers[name](post({ intakeId: 'x', callId: 'x' }, 'Bearer test-secret-value'))
      expect(res.status).not.toBe(401)
    })
  }
})

describe('every internal caller sends the shared secret', () => {
  for (const file of CALLERS) {
    it(`${file} attaches an Authorization header to its internal fetch`, () => {
      const src = read(file)
      // Find each fetch that targets one of the guarded paths, then assert the
      // same call carries the header. Matching the whole fetch(...) call keeps
      // an unrelated Authorization elsewhere in the file from passing this.
      const calls = src.match(
        /fetch\(\s*`?[^`)]*\/api\/(?:estimate\/draft|intake\/structure)[\s\S]{0,600}?\n\s*\}\)/g,
      )
      expect(calls, `no internal fetch found in ${file}`).not.toBeNull()
      for (const call of calls!) {
        expect(call, `internal fetch in ${file} has no Authorization header`).toMatch(
          /Authorization:\s*`Bearer \$\{process\.env\.CRON_SECRET\}`/,
        )
      }
    })
  }

  it('no in-app caller was missed', () => {
    // If a NEW caller appears and is not in CALLERS, this fails — which is the
    // whole point: an unlisted caller ships without the header and that channel
    // silently stops producing quotes.
    const globbed = globCallers()
    const missing = globbed.filter((f) => !(CALLERS as readonly string[]).includes(f))
    expect(missing, 'new internal caller not covered by this test').toEqual([])
  })
})

/** Walk app/ for files that fetch either guarded route. */
function globCallers(): string[] {
  // --untracked, because a new caller ships as an uncommitted file first — the
  // realistic way one would slip past this. `-- app lib` because lib/ is on the
  // same path (lib/sms/start-web-lead-conversation.ts already sits there).
  // An empty result makes execSync exit non-zero, so there is no silent-pass mode.
  const out = execSync(
    'git grep --untracked -l -E "fetch\\(.*api/(estimate/draft|intake/structure)" -- app lib',
    { cwd: ROOT, encoding: 'utf8' },
  )
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

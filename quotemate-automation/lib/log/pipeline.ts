// Pipeline logger — emits scannable, filterable lines to stdout so the
// quote pipeline is observable in Vercel's log viewer.
//
// Format:  [QM step:scope:traceId] ▶/✓/✗ event · key=value · t+1.2s
//
// Filter in Vercel logs by typing "[QM" to see all pipeline events,
// or "traceId:abc12345" to follow one specific call end-to-end.

const TOTAL_STEPS = 4

type Scope = 'webhook' | 'intake' | 'estimate' | 'sms'

const STEP_BY_SCOPE: Record<Scope, number> = {
  webhook: 1,
  intake: 2,
  estimate: 3,
  sms: 4,
}

function fmtKv(data?: Record<string, unknown>): string {
  if (!data) return ''
  return Object.entries(data)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ')
}

export function pipelineLog(scope: Scope, traceId?: string) {
  const step = STEP_BY_SCOPE[scope]
  const tag = `[QM ${step}/${TOTAL_STEPS}:${scope}${traceId ? ':' + traceId.slice(0, 8) : ''}]`
  const startMs = Date.now()

  const elapsed = () => `t+${((Date.now() - startMs) / 1000).toFixed(1)}s`

  return {
    /** event currently in flight */
    step: (event: string, data?: Record<string, unknown>) => {
      const kv = fmtKv(data)
      console.log(`${tag} ▶ ${event}${kv ? ' · ' + kv : ''} · ${elapsed()}`)
    },
    /** event completed successfully */
    ok: (event: string, data?: Record<string, unknown>) => {
      const kv = fmtKv(data)
      console.log(`${tag} ✓ ${event}${kv ? ' · ' + kv : ''} · ${elapsed()}`)
    },
    /** event failed — recoverable or terminal */
    err: (event: string, error?: unknown, data?: Record<string, unknown>) => {
      const msg = error instanceof Error ? error.message : error == null ? '' : String(error)
      const kv = fmtKv(data)
      console.error(`${tag} ✗ ${event}${msg ? ' · ' + msg : ''}${kv ? ' · ' + kv : ''} · ${elapsed()}`)
    },
    /** terminal — call this when the route is fully done */
    done: (event = 'route done', data?: Record<string, unknown>) => {
      const kv = fmtKv(data)
      console.log(`${tag} ✅ ${event}${kv ? ' · ' + kv : ''} · ${elapsed()}`)
    },
  }
}

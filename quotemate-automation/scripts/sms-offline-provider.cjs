// Test-only preload for built-service smoke tests. Every remote request is
// intercepted; an unexpected provider operation fails instead of reaching it.
const realFetch = globalThis.fetch
const receipts = new Map()
globalThis.fetch = async (input, options) => {
  const req = new Request(input, options), url = new URL(req.url)
  if (['127.0.0.1','localhost'].includes(url.hostname)) return realFetch(input,options)
  if (url.hostname !== 'sms-audit.invalid') throw new Error('Offline contract forbids external request')
  const path = url.pathname
  if (path.endsWith('/rpc/enqueue_sms_work')) {
    const payload = await req.json()
    if (!receipts.has(payload.p_key)) receipts.set(payload.p_key, {
      id: '00000000-0000-4000-8000-000000000002', turn_id: payload.p_turn_id,
      status: 'pending', kind: payload.p_kind, service_key: payload.p_service,
    })
    return Response.json(receipts.get(payload.p_key))
  }
  if (path.endsWith('/rpc/claim_sms_work') || path.endsWith('/sms_outbox')) return Response.json([])
  // Readiness must fail schema capability without causing external IO.
  return Response.json({ message: 'Offline schema unavailable', code: 'OFFLINE' },{status:400})
}

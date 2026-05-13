// Update an existing Vapi assistant in place.
//
// Used when the tenant's trade portfolio changes after activation —
// e.g. a sparky adds plumbing to their account, and the AI receptionist
// needs to start greeting plumbing callers without losing the existing
// assistant ID (which Twilio routing depends on).
//
// Gated by the same VAPI_PROVISIONING_ENABLED flag as the create call.
// When stubbed, returns ok+stubbed so the caller can proceed without
// hitting the network.

const VAPI_API = 'https://api.vapi.ai'

export type VapiUpdateResult =
  | { ok: true; stubbed: false }
  | { ok: true; stubbed: true }
  | { ok: false; reason: string }

export async function updateVapiAssistant(opts: {
  assistantId: string
  businessName: string
  /** Full trade portfolio after the change. Length 1 or 2. */
  trades: Array<'electrical' | 'plumbing'>
}): Promise<VapiUpdateResult> {
  if (process.env.VAPI_PROVISIONING_ENABLED !== 'true') {
    return { ok: true, stubbed: true }
  }
  const apiKey = process.env.VAPI_API_KEY
  if (!apiKey) {
    return { ok: false, reason: 'VAPI_API_KEY not set' }
  }
  if (opts.trades.length === 0) {
    return { ok: false, reason: 'updateVapiAssistant called with empty trades[]' }
  }

  const tradeLabel = renderTradeLabel(opts.trades)
  const firstMessage =
    `G'day, you've reached ${opts.businessName}. ` +
    `I'm the AI quoting assistant — I can take down details for your ${tradeLabel} job and get a quote across. ` +
    `This call may be recorded for quality and quote drafting. Sound good?`

  const systemPrompt = buildSystemPrompt(opts.businessName, opts.trades)

  // Vapi documents PATCH /assistant/{id} as the canonical partial-update
  // endpoint. We only send the fields that depend on the trade portfolio
  // — leaving voice, transcriber, server URL, etc. untouched.
  const body = {
    firstMessage,
    model: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.2,
      systemPrompt,
    },
    metadata: { trades: opts.trades },
  }

  try {
    const res = await fetch(
      `${VAPI_API}/assistant/${encodeURIComponent(opts.assistantId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    if (!res.ok) {
      const text = await res.text()
      const parsed = (() => {
        try { return JSON.parse(text) } catch { return null }
      })()
      return {
        ok: false,
        reason:
          parsed?.message ??
          parsed?.error ??
          `HTTP ${res.status}: ${text.slice(0, 200)}`,
      }
    }
    return { ok: true, stubbed: false }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: `Vapi PATCH threw: ${msg}` }
  }
}

function renderTradeLabel(trades: Array<'electrical' | 'plumbing'>): string {
  if (trades.length === 1) return trades[0]
  return trades.join(' or ')
}

function buildSystemPrompt(
  businessName: string,
  trades: Array<'electrical' | 'plumbing'>,
): string {
  const tradeLabel = renderTradeLabel(trades)
  const contractorDescription =
    trades.length > 1 ? `${trades.join(' and ')} contractor` : `${trades[0]} contractor`
  const easyFiveContext = trades
    .map((t) => `recognise the easy-5 job types for ${t}`)
    .join(' and ')

  return `You are the AI receptionist for ${businessName}, an Australian ${contractorDescription}.

Your job is to greet the caller, capture the key details for their ${tradeLabel} job (location, what they need done, when), and confirm what you heard at the end of the call. Do NOT quote prices on the phone — a structured quote will be drafted automatically after the call and sent via SMS.

TONE: Australian, professional, friendly. Plain English. No filler. Match the cadence of a busy suburban tradie's receptionist.

WHAT TO ASK:
1. First name
2. Suburb / location of the job
3. What ${tradeLabel} work they need (use plain language; ${easyFiveContext})
4. When they need it done (urgent / this week / flexible)
5. Confirm what you heard before ending

WHAT NOT TO DO:
- Never quote prices on the call.
- Never promise a tradie will attend on a specific day.
- If the job sounds dangerous (smell gas, sparks, burst pipe, water through ceiling), flag it as an emergency and ask if they need urgent attention.

When the caller confirms the summary, thank them and end the call. The quote will arrive by SMS within a couple of minutes.`
}

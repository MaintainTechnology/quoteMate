// Shared Vapi voice-assistant prompt builder (admin bulk loader, Phase 0).
//
// provision.ts (assistant create) and update-assistant.ts (trade-portfolio
// change) both need the identical greeting + system prompt. This is the
// single source so the two cannot drift — and so the trade types widen in
// one place.
//
// The prompt is COMPOSED from the tenant's trade portfolio, which is data
// (`tenants.trades[]`): a new install-type trade added there is spoken with
// no code change — the §3 blocker was only the `'electrical' | 'plumbing'`
// TYPE, which is now `string`.
//
// `VoicePromptOverride` is the trade_prompts hook (spec §6.3): a trade may
// supply bespoke `voice_greeting` / `voice_system_prompt` text. electrical
// and plumbing supply neither, so they compose exactly as before — the
// voice-prompt parity test pins that.

export type VoicePromptOverride = {
  greeting?: string | null
  systemPrompt?: string | null
}

/** Call-language label for a trade portfolio:
 *   ['electrical']            → "electrical"
 *   ['electrical','plumbing'] → "electrical or plumbing"
 */
export function renderTradeLabel(trades: readonly string[]): string {
  if (trades.length === 1) return trades[0]
  return trades.join(' or ')
}

/** The assistant's opening line. A trade's voice_greeting override, when
 *  present, replaces the composed greeting verbatim. */
export function buildVoiceFirstMessage(
  businessName: string,
  trades: readonly string[],
  override?: VoicePromptOverride,
): string {
  if (override?.greeting && override.greeting.trim() !== '') {
    return override.greeting
  }
  const tradeLabel = renderTradeLabel(trades)
  return (
    `G'day, you've reached ${businessName}. ` +
    `I'm the AI quoting assistant — I can take down details for your ${tradeLabel} job and get a quote across. ` +
    `This call may be recorded for quality and quote drafting. Sound good?`
  )
}

/** The assistant's system prompt. A trade's voice_system_prompt override,
 *  when present, replaces the composed prompt verbatim. */
export function buildVoiceSystemPrompt(
  businessName: string,
  trades: readonly string[],
  override?: VoicePromptOverride,
): string {
  if (override?.systemPrompt && override.systemPrompt.trim() !== '') {
    return override.systemPrompt
  }
  const tradeLabel = renderTradeLabel(trades)
  const contractorDescription =
    trades.length > 1
      ? `${trades.join(' and ')} contractor`
      : `${trades[0]} contractor`
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

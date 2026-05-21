// Vapi assistant provisioning for a newly onboarded tradie.
//
// Each tradie gets their own Vapi assistant — one assistant ID per
// tenant. The Vapi inbound webhook resolves tenant by assistant ID, so
// the right pricing book + trade prompt are used for every call.
//
// Gated by env flag `VAPI_PROVISIONING_ENABLED=true`. When disabled,
// returns a deterministic stub ID so the rest of the activate flow can
// complete without hitting the Vapi API.

import {
  buildVoiceFirstMessage,
  buildVoiceSystemPrompt,
} from './voice-prompt'

const VAPI_API = 'https://api.vapi.ai'

export type VapiProvisionResult =
  | { ok: true; stubbed: false; assistantId: string }
  | { ok: true; stubbed: true; assistantId: string }
  | { ok: false; reason: string }

export async function provisionVapiAssistant(opts: {
  tenantId: string
  businessName: string
  /** Primary trade — used when only one is configured. Any registered
   *  trade name (data-driven since the admin bulk loader, Phase 0). */
  trade: string
  /** All trades this tenant offers. When length > 1 the assistant
   *  prompt and greeting acknowledge both. Falls back to [trade]. */
  trades?: string[]
  voicePersona?: string                  // default 'jon'
  /** The phone number this assistant will be bound to (for first-message context) */
  phoneNumber?: string
}): Promise<VapiProvisionResult> {
  if (process.env.VAPI_PROVISIONING_ENABLED !== 'true') {
    return {
      ok: true,
      stubbed: true,
      assistantId: `vapi-stub-${opts.tenantId.slice(0, 8)}`,
    }
  }

  const apiKey = process.env.VAPI_API_KEY
  if (!apiKey) {
    return { ok: false, reason: 'VAPI_API_KEY not set' }
  }

  const persona = opts.voicePersona ?? 'jon'

  // Greeting + system prompt composed from the tenant's trade portfolio
  // (data) — see lib/vapi/voice-prompt.ts. A new trade is spoken with no
  // code change here.
  const trades = opts.trades && opts.trades.length > 0 ? opts.trades : [opts.trade]

  const firstMessage = buildVoiceFirstMessage(opts.businessName, trades)
  const systemPrompt = buildVoiceSystemPrompt(opts.businessName, trades)

  const body = {
    name: `${opts.businessName} — QuoteMate`,
    metadata: { tenant_id: opts.tenantId, trade: opts.trade, trades },
    firstMessage,
    model: {
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.2,
      systemPrompt,
    },
    voice: {
      provider: '11labs',
      voiceId: voiceIdForPersona(persona),
    },
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en-AU',
    },
    // Tools / server URL wiring is added in Phase 1c when the inbound
    // /api/vapi/webhook is tenant-aware. For now, the assistant exists
    // and can take basic calls; quote drafting is triggered by the
    // post-call webhook which we'll fork next.
    serverUrl: `${process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/vapi/webhook`,
  }

  try {
    const res = await fetch(`${VAPI_API}/assistant`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    const parsed = (() => { try { return JSON.parse(text) } catch { return null } })()
    if (!res.ok) {
      return {
        ok: false,
        reason: parsed?.message ?? parsed?.error ?? `HTTP ${res.status}: ${text.slice(0, 200)}`,
      }
    }
    if (!parsed?.id) {
      return { ok: false, reason: 'Vapi response missing id field' }
    }
    return { ok: true, stubbed: false, assistantId: parsed.id }
  } catch (e: any) {
    return { ok: false, reason: `Vapi create threw: ${e?.message ?? String(e)}` }
  }
}

/** Maps a persona name to a known 11labs voice ID. */
function voiceIdForPersona(persona: string): string {
  // Default voice IDs — replace with your tradie-vetted picks in env if needed.
  const PERSONA_VOICES: Record<string, string> = {
    jon:   process.env.VAPI_VOICE_JON   ?? 'pNInz6obpgDQGcFmaJgB',
    sarah: process.env.VAPI_VOICE_SARAH ?? 'EXAVITQu4vr4xnSDxMaL',
    mike:  process.env.VAPI_VOICE_MIKE  ?? 'TX3LPaxmHKxFdv7VOQHJ',
    anna:  process.env.VAPI_VOICE_ANNA  ?? 'XB0fDUnXU5powFXDhCwa',
  }
  return PERSONA_VOICES[persona] ?? PERSONA_VOICES.jon
}

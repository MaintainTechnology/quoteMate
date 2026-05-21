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

import {
  buildVoiceFirstMessage,
  buildVoiceSystemPrompt,
} from './voice-prompt'

const VAPI_API = 'https://api.vapi.ai'

export type VapiUpdateResult =
  | { ok: true; stubbed: false }
  | { ok: true; stubbed: true }
  | { ok: false; reason: string }

export async function updateVapiAssistant(opts: {
  assistantId: string
  businessName: string
  /** Full trade portfolio after the change. Any registered trade names
   *  (data-driven since the admin bulk loader, Phase 0). */
  trades: string[]
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

  const firstMessage = buildVoiceFirstMessage(opts.businessName, opts.trades)
  const systemPrompt = buildVoiceSystemPrompt(opts.businessName, opts.trades)

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

// The voice greeting + system prompt builders are shared with provision.ts
// in lib/vapi/voice-prompt.ts — kept in one place so a create and an update
// can never drift.

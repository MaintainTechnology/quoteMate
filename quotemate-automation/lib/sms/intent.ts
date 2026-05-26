// SMS first-turn intent classifier.
//
// Decides whether an inbound SMS on the shared QuoteMate number is:
//   • 'tradie_registration' — a tradie wanting to sign up
//   • 'customer_quote'      — a homeowner / customer wanting a quote
//   • 'ambiguous'           — neither pattern matched cleanly
//
// HYBRID strategy:
//   1. Regex-first (cheap + deterministic + reviewable). Catches ~80%
//      of inbounds with clear phrasing — no API call, sub-millisecond.
//   2. Sonnet fallback when regex is ambiguous AND the message is long
//      enough to be worth classifying (≥4 words). Cross-encoder-style
//      semantic classification handles the nuanced middle ground
//      ("I'm a sparky looking to get on the platform", "list me").
//   3. On Sonnet failure (network, rate-limit, etc.) we fall back to
//      'ambiguous' which routes to customer flow — the safer default.
//
// Pure regex is exposed as `classifyIntentSync` for places that need
// a synchronous decision. The async `classifyIntent` is the
// recommended entry point for the SMS inbound handler.

/** Strong-match tradie phrases — clear intent to register. */
const TRADIE_PHRASES: RegExp[] = [
  /\b(register|sign\s*up|enrol|enroll|join)\b.*\b(tradie|tradesman|sparky|sparkie|plumber|electrician|business)\b/i,
  /\b(tradie|tradesman|sparky|sparkie|plumber|electrician)\b.*\b(register|sign\s*up|join)\b/i,
  /\b(i'?m|i\s*am)\s+a\s+(tradie|tradesman|sparky|sparkie|plumber|electrician)\b.*\b(register|sign|use|join)/i,
  /\bbecome\s+(a\s+)?quotemate\b/i,
  /\blist\s+my\s+(business|trade|company|services?)\b/i,
  /\b(sign\s+me\s+up|register\s+me|join\s+me\s+up)\b/i,
  /\bset\s+up\s+(my|an)\s+(account|business)\b/i,
  /\bi\s+want\s+to\s+register\b/i,
  /\bi\s+want\s+to\s+(join|sign\s*up)\b/i,
  /\b(create|make)\s+(a|my)\s+(tradie|business)\s+account\b/i,
]

/** Strong-match customer phrases — clear intent to get a quote. */
const CUSTOMER_PHRASES: RegExp[] = [
  /\b(quote|estimate|price)\b.*\b(for|on|to)\b/i,
  /\b(blocked|leaking|broken|dripping|cracked|burst)\b/i,
  /\bcan\s+(you|someone)\s+(come|fix|repair|install|quote)\b/i,
  /\b(my|our)\s+(tap|toilet|drain|sink|gpo|switch|fan|light|hot\s*water)\b/i,
  /\bhow\s+much\s+(to|for|would)\b/i,
  /\bneed\s+(a|an|some)\s+(quote|estimate|plumber|sparky|electrician)\b/i,
  /\bi\s+(have|got)\s+a\s+(broken|leaking|blocked|dripping)\b/i,
]

export type IntentClassification = {
  intent: 'tradie_registration' | 'customer_quote' | 'ambiguous'
  source:
    | 'regex_tradie'
    | 'regex_customer'
    | 'regex_conflict'
    | 'short_message'
    | 'no_match'
    | 'sonnet'
    | 'sonnet_failed'
  matchedPattern?: string
  /** Sonnet's free-form one-liner reasoning, for debug logs only. */
  reasoning?: string
  /** Confidence band from Sonnet. Regex matches are implicitly HIGH. */
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW'
}

/**
 * Pure regex classifier — sync, free, deterministic, reviewable.
 * Returns 'ambiguous' for anything that doesn't match a strong phrase.
 * Use this when you need a sync answer or when the LLM is unavailable.
 */
export function classifyIntentSync(message: string): IntentClassification {
  const trimmed = (message ?? '').trim()
  if (!trimmed) {
    return { intent: 'ambiguous', source: 'short_message' }
  }

  const tradieMatch = TRADIE_PHRASES.find((re) => re.test(trimmed))
  const customerMatch = CUSTOMER_PHRASES.find((re) => re.test(trimmed))

  // Both matched (rare) → safer to assume customer; the tradie can
  // try again with clearer wording or the canned disambiguation
  // message will catch them next turn.
  if (tradieMatch && customerMatch) {
    return {
      intent: 'customer_quote',
      source: 'regex_conflict',
      matchedPattern: customerMatch.source,
      confidence: 'HIGH',
    }
  }

  if (tradieMatch) {
    return {
      intent: 'tradie_registration',
      source: 'regex_tradie',
      matchedPattern: tradieMatch.source,
      confidence: 'HIGH',
    }
  }
  if (customerMatch) {
    return {
      intent: 'customer_quote',
      source: 'regex_customer',
      matchedPattern: customerMatch.source,
      confidence: 'HIGH',
    }
  }

  // No regex match — short messages are likely customer greetings
  // ("hi", "g'day"). Default to customer flow; the existing dialog
  // handles greetings gracefully via its first-turn opener.
  if (trimmed.split(/\s+/).length < 4) {
    return { intent: 'ambiguous', source: 'short_message' }
  }

  return { intent: 'ambiguous', source: 'no_match' }
}

/**
 * Hybrid classifier — regex-first, Sonnet for ambiguous middle ground.
 *
 * Hot-path-friendly:
 *   • ≤80% of inbounds resolve via regex (sub-millisecond, no API call)
 *   • Remaining ambiguous cases hit Sonnet (~200-400ms, ~$0.0001/call)
 *   • Sonnet failures gracefully degrade to 'ambiguous' → customer flow
 *
 * Use this from /api/sms/inbound on turn 1 of every new conversation.
 */
export async function classifyIntent(
  message: string,
): Promise<IntentClassification> {
  const regex = classifyIntentSync(message)
  if (regex.intent !== 'ambiguous') return regex

  // Short messages are likely greetings — don't waste a Sonnet call.
  if (regex.source === 'short_message') return regex

  // Long-form ambiguous → ask Sonnet.
  return await classifyIntentWithSonnet(message)
}

// ─── Sonnet-based fallback ───────────────────────────────────────────
// Lazy-imported so the regex sync path stays free of the AI SDK
// bundle when callers only need classifyIntentSync.

const SONNET_SYSTEM_PROMPT = `You classify Australian SMS messages received by QuoteMate, an AI quoting platform for tradies.

QuoteMate's number is shared between:
  • Tradies who want to register and use QuoteMate for their business
  • Customers (homeowners) who want a quote for a job

Classify the message as one of:
  • "tradie_registration" — sender wants to sign up as a tradie to use the platform
  • "customer_quote"      — sender wants a quote for work at their home

CRITICAL DISAMBIGUATION RULES

1. A customer mentioning their own tradie is NOT registration intent.
   "My sparky didn't turn up" → customer_quote
   "I need a plumber" → customer_quote
   "Got a problem with my electrician's work" → customer_quote

2. A tradie mentioning customer-style words like "quote" is still registration intent
   if the framing is "as a tradie".
   "I do quotes for sparky work, want to use this" → tradie_registration
   "How do I list my plumbing business?" → tradie_registration

3. Default LOW confidence when neither path is obvious. Use HIGH only
   for unambiguous cases.

EXAMPLES OF tradie_registration (HIGH)
  - "I want to register as a tradie"
  - "Can you sign me up? I'm a sparky in Bondi"
  - "How do I become a QuoteMate tradie?"
  - "List my plumbing business please"
  - "I'm a tradesman looking to use your platform"

EXAMPLES OF customer_quote (HIGH)
  - "Need a quote for blocked drain"
  - "How much for 6 downlights?"
  - "Can you fix my leaking tap?"
  - "Got a sparky who can come tomorrow?"

EXAMPLES OF MEDIUM / LOW confidence
  - "Hi" → LOW, default to customer
  - "Help" → LOW
  - "I'm a sparky" → MEDIUM tradie_registration (no clear intent stated)
  - "Plumber needed" → MEDIUM customer_quote (could be tradie misspeaking)
`

async function classifyIntentWithSonnet(
  message: string,
): Promise<IntentClassification> {
  try {
    // Dynamic import keeps the regex path free of the AI SDK dependency.
    const { anthropic } = await import('@ai-sdk/anthropic')
    const { generateObject } = await import('ai')
    const { z } = await import('zod')

    const Schema = z.object({
      intent: z.enum(['tradie_registration', 'customer_quote']),
      confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      reasoning: z.string().max(120),
    })

    const { object } = await generateObject({
      // Upgraded 2026-05-14 from Haiku 4.5 → Sonnet 4.6 alongside the
      // dialog and slot extractor. Intent classification (customer-vs-tradie,
      // payment ack vs follow-up question) gets sharper with Sonnet on the
      // short ambiguous messages where Sonnet occasionally misroutes.
      model: anthropic('claude-sonnet-4-6'),
      schema: Schema,
      system: SONNET_SYSTEM_PROMPT,
      prompt: `Customer message: "${message.slice(0, 500)}"`,
      maxRetries: 1,
    })

    // LOW confidence → don't trust either classification. Treat as
    // ambiguous so the existing customer dialog gracefully takes over.
    if (object.confidence === 'LOW') {
      return {
        intent: 'ambiguous',
        source: 'sonnet',
        confidence: object.confidence,
        reasoning: object.reasoning,
      }
    }

    return {
      intent: object.intent,
      source: 'sonnet',
      confidence: object.confidence,
      reasoning: object.reasoning,
    }
  } catch (e: any) {
    console.warn(
      '[sms/intent] Sonnet classification failed — defaulting to ambiguous',
      e?.message ?? String(e),
    )
    return { intent: 'ambiguous', source: 'sonnet_failed' }
  }
}

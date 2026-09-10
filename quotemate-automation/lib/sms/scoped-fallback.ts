import { generateObject } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import type { ConversationTurn, TurnDecision } from './dialog'
import { SMS_RECEPTIONIST_MODEL } from './model'
import { guardGeneratedQuoteLinks } from './quote-actions'

/** Dedicated trade flows use this only after their deterministic tools had
 * first refusal. It keeps ordinary questions alive without inventing prices,
 * booking promises, a quote, or a completed handoff.
 */
export async function decideScopedFallback(args: {
  history: ConversationTurn[]; inboundCount: number
}, trade: 'roofing' | 'painting' | 'solar'): Promise<TurnDecision> {
  const text = [...args.history].reverse().find((t) => t.direction === 'inbound')?.body ?? ''
  const goodbye = /^(?:bye|goodbye|thanks(?: mate)?|cheers|all good|nothing else|cancel|stop)[.!\s]*$/i.test(text.trim())
  let reply = goodbye ? 'Thanks for getting in touch. You can message again whenever you need help.'
    : `I can help with your ${trade} request. What would you like to check or change?`
  if (!goodbye && /\b(price|cost|how much|quote|link)\b/i.test(text)) {
    reply = `I can check an existing ${trade} quote without changing its price. Say “send the quote link again”, or tell me the job address if you have more than one request.`
  } else if (!goodbye) {
    try {
      const result = await generateObject({
        model: anthropic(SMS_RECEPTIONIST_MODEL), maxRetries: 0, abortSignal: AbortSignal.timeout(12_000),
        schema: z.object({ reply: z.string().min(1).max(300) }),
        system: `You assist an Australian ${trade} business by SMS. Answer the customer's actual question briefly using only the supplied conversation facts. Ask one useful clarification when needed. Never provide prices, currency amounts, URLs, booking commitments, delivery timelines or claims that a quote or notification has been sent. Never promise a human callback. Never end a conversation unless the customer explicitly says goodbye. You can explain that draft quotes require the tradie's approval. You cannot operate tools in this fallback.`,
        prompt: args.history.slice(-16).map((t) => `${t.direction === 'inbound' ? 'Customer' : 'Assistant'}: ${t.body}`).join('\n'),
      })
      reply = guardGeneratedQuoteLinks(result.object.reply)
      // Tools alone own money and workflow completion claims.
      if (/[$€£]|\b\d+(?:\.\d+)?\s*(?:dollars?|aud)\b|(?:sent|forwarded|notified|on (?:its|the) way|call.{0,12}(?:back|soon)|quote.{0,15}(?:soon|minutes))/i.test(reply)) {
        reply = `I can help check or update your ${trade} request. A draft needs the tradie's approval before a quote can be shared. What would you like to check?`
      }
    } catch { /* The durable turn still gets a usable clarification on model failure. */ }
  }
  return { action: goodbye ? 'end_conversation' : 'ask', job_type_guess: 'unknown', reply_to_send: reply,
    assumptions_made: [], ready_for_intake: false, reason_for_escalation: null,
    request_photo_link: false, offer_product_choice: false }
}

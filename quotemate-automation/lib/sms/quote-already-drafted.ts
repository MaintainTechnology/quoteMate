/** Completion is a persisted quote ID. An intake or running job is a separate stage. */
export type QuoteAlreadyDraftedPrior = {
  status?: string | null
  intake_id?: string | null
  quote_id?: string | null
  quote_stage?: string | null
} | null | undefined
export type ConversationMode = 'new' | 'reuse' | 'inflight'
export function quoteAlreadyDrafted(mode: ConversationMode, prior: QuoteAlreadyDraftedPrior): boolean {
  return mode !== 'new' && !!prior?.quote_id
}

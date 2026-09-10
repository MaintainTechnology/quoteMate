import { z } from 'zod'

export const followupUuid = z.uuid().transform(value => value.toLowerCase())
const targetFields = { quoteId: followupUuid.optional(), conversationId: followupUuid.optional() }
const oneTarget = (value: { quoteId?: string; conversationId?: string }) =>
  Boolean(value.quoteId) !== Boolean(value.conversationId)
const sendFields = { requestId: followupUuid, ...targetFields, expectedRecipient: z.string().trim().min(1).max(32).optional() }
export const followupTextBody = z.object({ ...sendFields, text: z.string().max(640).trim().min(1) }).strict().refine(oneTarget)
export const followupCallBody = z.object(sendFields).strict().refine(oneTarget)
export const followupTargetQuery = z.object(targetFields).strict().refine(oneTarget)
export const followupOperationQuery = z.object({ requestId: followupUuid, ...targetFields }).strict().refine(oneTarget)
export const followupNoteBody = z.object({
  requestId: followupUuid, quoteId: followupUuid, kind: z.literal('note'),
  outcome: z.enum(['left_voicemail', 'spoke', 'no_answer', 'wants_callback', 'not_interested', 'other']),
  note: z.string().max(500).trim().optional(), preserveChase: z.boolean().default(false),
}).strict()
export type FollowupAction = 'text' | 'call' | 'note'
export type FollowupInput = z.infer<typeof followupTextBody> | z.infer<typeof followupCallBody> | z.infer<typeof followupNoteBody>
export type FollowupOperation = {
  ok: true; requestId: string; action: FollowupAction; target: { kind: 'quote' | 'conversation'; id: string }
  status: 'not_found' | 'pending' | 'unknown' | 'accepted' | 'failed' | 'complete'
  accepted: boolean; history: 'pending' | 'complete' | 'not_applicable'
  eventId: string | null; outboxId: string | null; providerSid: string | null; message: string
}
export const followupOperationResponse = z.object({
  ok: z.literal(true), requestId: followupUuid, action: z.enum(['text', 'call', 'note']),
  target: z.object({ kind: z.enum(['quote', 'conversation']), id: followupUuid }).strict(),
  status: z.enum(['not_found', 'pending', 'unknown', 'accepted', 'failed', 'complete']), accepted: z.boolean(),
  history: z.enum(['pending', 'complete', 'not_applicable']), eventId: followupUuid.nullable(),
  outboxId: followupUuid.nullable(), providerSid: z.string().nullable(), message: z.string(),
}).strict().superRefine((value, ctx) => {
  const invalid = () => ctx.addIssue({ code: 'custom', message: 'Inconsistent operation evidence' })
  const sidValid = value.action === 'call' ? /^CA[0-9a-fA-F]{32}$/.test(value.providerSid ?? '') : /^(SM|MM)[0-9a-fA-F]{32}$/.test(value.providerSid ?? '')
  if (value.accepted && (value.action === 'note' || !sidValid || (value.action === 'text' && !value.outboxId)))
    ctx.addIssue({ code: 'custom', message: 'Unconfirmed acceptance' })
  if (value.status === 'complete' && (value.history !== 'complete' || (value.target.kind === 'quote' && !value.eventId) || (value.action !== 'note' && !value.accepted)))
    ctx.addIssue({ code: 'custom', message: 'Incomplete operation evidence' })
  if (value.accepted !== Boolean(value.providerSid) || (value.outboxId && value.action !== 'text')) invalid()
  if (value.action === 'note' && (value.target.kind !== 'quote' || value.accepted || value.outboxId)) invalid()
  if (value.target.kind === 'conversation' && value.eventId) invalid()
  if (value.eventId && value.history !== 'complete') invalid()
  if (value.history === 'complete' && (value.status !== 'complete' && value.status !== 'accepted')) invalid()
  if (value.history === 'complete' && value.target.kind === 'quote' && !value.eventId) invalid()
  if (value.status === 'not_found' && (value.accepted || value.history !== 'not_applicable' || value.eventId || value.outboxId || value.providerSid)) invalid()
  if (['pending', 'unknown', 'failed'].includes(value.status) && (value.accepted || value.history !== 'pending' || value.eventId || value.providerSid)) invalid()
  if (value.status === 'accepted' && (!value.accepted || value.history === 'not_applicable')) invalid()
  if (value.accepted && value.status !== 'accepted' && value.status !== 'complete') invalid()
})
export function followupTarget(input: { quoteId?: string; conversationId?: string }): FollowupOperation['target'] {
  return input.quoteId ? { kind: 'quote', id: followupUuid.parse(input.quoteId) } : { kind: 'conversation', id: followupUuid.parse(input.conversationId) }
}
export function followupOutcomeLabel(outcome: string): string {
  return ({ left_voicemail: 'Left voicemail', spoke: 'Spoke with customer', no_answer: 'No answer',
    wants_callback: 'Wants a callback', not_interested: 'Not interested', other: 'Other' } as Record<string, string>)[outcome] ?? outcome
}

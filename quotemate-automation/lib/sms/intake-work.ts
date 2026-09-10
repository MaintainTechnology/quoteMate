/** All entry points for one conversation share a serial lane and input identity.
 * Twilio's receipt SID is stable before and after sms_messages persistence.
 * A platform-created form message has no provider SID, so its row ID is used.
 */
export function smsIntakeWorkIdentity(input: {
  conversationId: string
  providerMessageSid?: string | null
  messageId?: string | null
}): { key: string; serialKey: string } {
  if (!input.conversationId.trim()) throw new Error('SMS intake conversation identity required')
  const source = `intake:sms:${input.conversationId}`
  const revision = input.providerMessageSid?.trim() || input.messageId?.trim() || 'initial'
  return { key: `${source}:${revision}`, serialKey: source }
}

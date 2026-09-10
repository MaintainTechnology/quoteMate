import { describe, expect, it } from 'vitest'
import { smsIntakeWorkIdentity } from './intake-work'

describe('SMS intake work identity across live inbound and platform handoffs', () => {
  it('uses the same provider receipt revision before and after message persistence', () => {
    const inbound = smsIntakeWorkIdentity({ conversationId: 'conversation-1', providerMessageSid: 'SM-one' })
    const platform = smsIntakeWorkIdentity({ conversationId: 'conversation-1', providerMessageSid: 'SM-one', messageId: 'row-one' })
    expect(inbound).toEqual(platform)
    expect(inbound).toEqual({ key: 'intake:sms:conversation-1:SM-one', serialKey: 'intake:sms:conversation-1' })
  })
  it('uses a new platform message as a revision in the same serial lane', () => {
    const first = smsIntakeWorkIdentity({ conversationId: 'conversation-1', messageId: 'form-row-1' })
    const second = smsIntakeWorkIdentity({ conversationId: 'conversation-1', providerMessageSid: '', messageId: 'form-row-2' })
    expect(first.key).not.toBe(second.key)
    expect(first.serialKey).toBe(second.serialKey)
    expect(second.key).toBe('intake:sms:conversation-1:form-row-2')
  })
  it('does not merge different conversations with the same source revision', () => {
    expect(smsIntakeWorkIdentity({ conversationId: 'first', messageId: 'row' }).serialKey)
      .not.toBe(smsIntakeWorkIdentity({ conversationId: 'second', messageId: 'row' }).serialKey)
  })
})

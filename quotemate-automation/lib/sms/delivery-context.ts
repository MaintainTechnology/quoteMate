import { AsyncLocalStorage } from 'node:async_hooks'

export type SmsDeliveryContext = {
  turnId: string
  tenantId?: string | null
  conversationId?: string | null
  workId?: string
  workOwner?: string
  /** Check the durable turn's fence immediately before accepting a new send. */
  assertOwnership?: () => Promise<void>
}
const storage = new AsyncLocalStorage<SmsDeliveryContext>()
export function withSmsDeliveryContext<T>(context: SmsDeliveryContext, fn: () => T): T {
  return storage.run({ ...context }, fn)
}
export function smsDeliveryContext(): SmsDeliveryContext | undefined { return storage.getStore() }
export function updateSmsDeliveryContext(context: Partial<SmsDeliveryContext>): void {
  const current = storage.getStore()
  if (current) Object.assign(current, context)
}

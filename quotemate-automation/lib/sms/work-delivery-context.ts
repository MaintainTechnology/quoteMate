import { withSmsDeliveryContext } from './delivery-context'
import { assertSmsWorkOwnership, type SmsWorkScope } from './durable-work'

export const smsDeliveryWorkScope: SmsWorkScope = (job, operation) => withSmsDeliveryContext({
  turnId: job.turn_id, tenantId: job.tenant_id, workId: job.id, workOwner: job.owner_token,
  assertOwnership: assertSmsWorkOwnership,
}, operation)

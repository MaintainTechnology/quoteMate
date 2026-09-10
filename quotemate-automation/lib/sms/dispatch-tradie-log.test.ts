import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./durable-outbox',()=>({dispatchDurably:vi.fn()}))
vi.mock('./tradie-log',()=>({recordTradieSend:vi.fn()}))
import { dispatchDurably } from './durable-outbox'
import { dispatchQuoteMessage } from './dispatch'
import { recordTradieSend } from './tradie-log'

beforeEach(()=>vi.clearAllMocks())
describe('all audiences use the durable delivery ledger',()=>{
  it.each(['tradie','customer'] as const)('persists %s sends before transport and returns their outbox identity',async audience=>{
    const result={ok:true as const,channel:'sms' as const,sid:'SM_saved',status:'accepted',outboxId:'durable-id'}
    vi.mocked(dispatchDurably).mockResolvedValue(result)
    const opts={to:'+61400111222',text:'review is ready',audience,tenantId:'tenant',deliveryKey:'same-operation'}
    expect(await dispatchQuoteMessage(opts)).toEqual(result)
    expect(dispatchDurably).toHaveBeenCalledWith(opts,expect.any(Function))
    expect(recordTradieSend).not.toHaveBeenCalled()
  })
  it('preserves a queued failure instead of inventing a delivered audit row',async()=>{
    const result={ok:false as const,smsAttempt:{code:'AMBIGUOUS',reason:'unknown acceptance'},smsAttempts:1,outboxId:'saved-failure'}
    vi.mocked(dispatchDurably).mockResolvedValue(result)
    expect(await dispatchQuoteMessage({to:'+61400000000',text:'review',audience:'tradie'})).toEqual(result)
    expect(recordTradieSend).not.toHaveBeenCalled()
  })
})

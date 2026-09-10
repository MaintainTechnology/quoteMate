import { createPlanReleaseFixture } from './sms-plan-created-release-fixture.mjs'

// Add only the two real SQL199 RPC boundaries omitted by the shared adapter.
// Deliberate enqueue failure is recorded separately from unexpected access.
export async function createPlanInvitationFixture(app, state) {
  const fixture = await createPlanReleaseFixture(app, state)
  const client = { ...fixture.client, async rpc(name, args) {
    if (name === 'sms_outbox_enqueue' && state.enqueueFailures > 0) {
      state.enqueueFailures--
      state.injected.push({ boundary: name, key: args.p_key })
      return { data: null, error: { code: 'OFFLINE_INJECTED_ENQUEUE_FAILURE' } }
    }
    const parameters = {
      sms_plan_request: ['p_tenant','p_from','p_to','p_body','p_sid','p_work','p_owner'],
      sms_outbox_retry: ['p_id','p_tenant'],
    }[name]
    if (!parameters) return fixture.client.rpc(name, args)
    try {
      if (Object.keys(args).sort().join() !== [...parameters].sort().join()) throw new Error(`Unexpected ${name} arguments`)
      const result = await fixture.pg.query(`select ${name}(${parameters.map((_, index) => `$${index + 1}`).join(',')}) as value`,
        parameters.map(key => args[key]))
      return { data: result.rows[0].value, error: null }
    } catch (error) { state.unexpected.push(String(error)); throw error }
  } }
  return { ...fixture, client }
}

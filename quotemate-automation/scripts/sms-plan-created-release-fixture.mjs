import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOwnerReleaseFixture } from './sms-owner-release-fixture.mjs'

// Additional local schema and private-storage boundary only. The actual upload
// producer, migration210, fenced worker, pricing, review and outbox stay real.
export async function createPlanReleaseFixture(app, state) {
  const fixture = await createOwnerReleaseFixture(app, state)
  await fixture.pg.exec(`alter table plan_uploads
    add column if not exists size_bytes integer,
    add column if not exists source text not null default 'dashboard',
    add column if not exists pdf_path text,
    add column if not exists sheet_hint text;
    alter table plan_upload_requests
    add column if not exists plan_upload_id uuid references plan_uploads(id),
    add column if not exists error text;
    alter table plan_extractions
    add column if not exists items jsonb not null default '[]',
    add column if not exists sheets_used jsonb,
    add column if not exists overall_note text,
    add column if not exists model text,
    add column if not exists runtime_seconds numeric,
    add column if not exists report_pdf_path text,
    add column if not exists trade text not null default 'electrical';`)
  await fixture.pg.exec(readFileSync(join(app, 'sql/migrations/210_sms_plan_work.sql'), 'utf8'))
  const fail = message => { state.unexpected.push(String(message)); throw new Error(String(message)) }
  const client = { ...fixture.client,
    from(table) {
      const query = fixture.client.from(table)
      // No remote request exists in this adapter; retain the actual owner
      // route's cancellable-builder shape and fail if cancellation preceded it.
      query.abortSignal = signal => { signal.throwIfAborted(); return query }
      return query
    },
    rpc(name, args) {
      if (name === 'sms_plan_quote_guard_ready') {
        const result = fixture.pg.query('select public.sms_plan_quote_guard_ready() as ready')
          .then(value => ({ data: value.rows[0].ready, error: null })).catch(fail)
        return Object.assign(result, { abortSignal(signal) { signal.throwIfAborted(); return result } })
      }
      if (name !== 'submit_sms_plan') return fixture.client.rpc(name, args)
      return (async () => {
      try {
        const expected = ['p_request','p_hash','p_filename','p_size','p_path','p_payload']
        if (Object.keys(args).sort().join() !== [...expected].sort().join()) return fail('Unexpected submit_sms_plan arguments')
        const result = await fixture.pg.query('select to_jsonb(submit_sms_plan($1,$2,$3,$4,$5,$6)) as result',
          expected.map(key => key === 'p_payload' ? JSON.stringify(args[key]) : args[key]))
        return { data: result.rows[0].result, error: null }
      } catch (error) { return fail(error) }
      })()
    },
    storage: { from(bucket) {
      if (bucket !== 'plan-pdfs') return fail(`Unexpected storage bucket ${bucket}`)
      return {
        async upload(path, bytes, options) {
          if (!/^[0-9a-f-]{36}\/[0-9a-f]{64}\/plan\.pdf$/.test(path) || options.contentType !== 'application/pdf' || options.upsert !== true) {
            return fail(`Unexpected plan upload ${path}`)
          }
          const saved = Buffer.from(bytes), prior = state.pdfs.get(`${bucket}:${path}`)
          if (prior && !Buffer.from(prior).equals(saved)) return fail('Immutable plan input bytes changed')
          state.pdfs.set(`${bucket}:${path}`, saved)
          state.uploads.push({ bucket, path, size: saved.length })
          return { data: { path }, error: null }
        },
        async download(path) {
          const bytes = state.pdfs.get(`${bucket}:${path}`)
          if (!bytes) return fail(`Unstored plan bytes ${path}`)
          state.downloads.push({ bucket, path })
          return { data: new Blob([bytes]), error: null }
        },
        createSignedUrl: async () => fail('Unexpected signed private PDF'),
      }
    } },
  }
  return { ...fixture, client }
}

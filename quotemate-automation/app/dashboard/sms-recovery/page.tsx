'use client'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { getAuthToken } from '@/lib/auth/client-token'

type Job = { id: string; kind: string; service_key: string; status: string; created_at: string }
type Task = { id: string; trade: string; reason: string; status: string; customer_phone: string; notification_error: string | null; resource_type: string | null; resource_id: string | null }
export default function SmsRecoveryPage() {
  const [jobs,setJobs] = useState<Job[]>([])
  const [tasks,setTasks] = useState<Task[]>([])
  const [notice,setNotice] = useState('Loading enquiries…')
  const [busy,setBusy] = useState(false)
  const load = useCallback(async()=>{
    const token = await getAuthToken()
    if (!token) throw new Error('Sign in to review your enquiries.')
    const res = await fetch('/api/tenant/sms-recovery',{headers:{Authorization:`Bearer ${token}`}})
    if (!res.ok) throw new Error('Enquiries are temporarily unavailable. Please try again.')
    const body = await res.json()
    return { jobs: body.jobs as Job[], tasks: body.tasks as Task[] }
  },[])
  const apply = useCallback((body: {jobs:Job[];tasks:Task[]})=>{setJobs(body.jobs);setTasks(body.tasks);setNotice('')},[])
  useEffect(()=>{let active=true;void load().then(body=>{if(active)apply(body)}).catch(e=>{if(active)setNotice(e.message)});return()=>{active=false}},[load,apply])
  async function act(id: string,action: 'retry'|'resolve') {
    setBusy(true)
    try {
      const token = await getAuthToken()
      const res = await fetch('/api/tenant/sms-recovery',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({id,action})})
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'The action could not be saved.')
      apply(await load())
      setNotice(action==='retry'?'The enquiry is queued to resume from its saved progress.':'The task is marked resolved.')
    } catch(e) { setNotice(e instanceof Error?e.message:'The action could not be saved.') } finally {setBusy(false)}
  }
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 text-text-pri">
    <h1 className="text-2xl font-semibold">Enquiries needing attention</h1>
    <p>Review saved requests, resume failed enquiries and check <Link className="underline" href="/dashboard/sms-delivery">SMS delivery</Link>.</p>
    <button disabled={busy} className="rounded border border-ink-line px-4 py-2" onClick={()=>void load().then(apply).catch(e=>setNotice(e.message))}>Refresh</button>
    <p role="status">{notice}</p>
    <h2 className="text-xl font-semibold">Tradie review</h2>
    {!tasks.length && <p>No unresolved review requests.</p>}
    <ul className="space-y-4">{tasks.map(task=><li key={task.id} className="space-y-2 rounded border border-ink-line p-4">
      <strong>{task.trade} · {task.customer_phone}</strong><p>{task.reason}</p>
      <p>{task.notification_error?'Owner notification needs attention':'Saved for review'}</p>
      {task.resource_type==='generic' && task.resource_id && <Link className="mr-4 underline" href={`/dashboard?quoteId=${encodeURIComponent(task.resource_id)}`}>Open saved quote</Link>}
      {task.resource_type && task.resource_type !== 'generic' && task.resource_id && <Link className="mr-4 underline" href={`/dashboard/quote-review?family=${encodeURIComponent(task.resource_type)}&id=${encodeURIComponent(task.resource_id)}`}>Review saved quote</Link>}
      <button disabled={busy} className="rounded border border-ink-line px-3 py-2" onClick={()=>void act(task.id,'resolve')}>Mark resolved</button>
    </li>)}</ul>
    <h2 className="text-xl font-semibold">Processing enquiries</h2>
    {!jobs.length && <p>No outstanding processing jobs.</p>}
    <ul className="space-y-4">{jobs.map(job=><li key={job.id} className="space-y-2 rounded border border-ink-line p-4">
      <strong>{job.kind==='estimate'?'Quote draft':job.kind==='intake'?'Job details':'Customer enquiry'}</strong>
      <p>{job.status==='failed'?'Needs recovery':job.status==='running'?'Processing':job.status==='retry'?'Retry scheduled':'Queued'} · {new Date(job.created_at).toLocaleString('en-AU')}</p>
      {job.service_key==='retired-platform' && <p>This number still routes to a retired receptionist. Contact QuoteMax support to correct the number route and recover this saved enquiry. Reference: {job.id}</p>}
      {job.status==='failed' && job.service_key!=='retired-platform' && <button disabled={busy} className="rounded border border-ink-line px-3 py-2" onClick={()=>void act(job.id,'retry')}>Resume this enquiry</button>}
    </li>)}</ul>
  </main>
}

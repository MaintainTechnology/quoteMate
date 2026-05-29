// POST /api/roofing/reverse-geocode — turns a {lng, lat} click on the
// dashboard map into an AU street address via Nominatim. The dashboard
// uses this to re-run the measurement when the tradie clicks an
// adjacent building (granny flat instead of the main house, etc.).
//
// Server-side only — Nominatim's terms request a User-Agent header
// which browsers cannot set. Routing it through here also lets us
// rate-limit + cache later without changing the client.

import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { reverseGeocode } from '@/lib/roofing/geocode'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const RequestSchema = z.object({
  lng: z.number(),
  lat: z.number(),
})

async function userIdFromBearer(req: Request): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.toLowerCase().startsWith('bearer ')) return null
  const token = auth.slice(7).trim()
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

export async function POST(req: Request) {
  const userId = await userIdFromBearer(req)
  if (!userId) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }
  const parsed = RequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const result = await reverseGeocode(parsed.data)
  return Response.json(result, { status: 200 })
}

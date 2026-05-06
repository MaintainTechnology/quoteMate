import { createClient } from '@supabase/supabase-js'
import { UploadForm } from './UploadForm'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export default async function UploadPage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params

  // Resolve the token in EITHER source table:
  //   • calls.photo_request_token         — voice-agent flow
  //   • sms_conversations.photo_request_token — SMS-agent flow (Phase 5)
  // The /api/upload/[token] route does the same; both are kept in sync.
  const { data: call } = await supabase
    .from('calls')
    .select('id, photo_request_token, photos_completed_at')
    .eq('photo_request_token', token)
    .maybeSingle()

  let resolved: { source: 'call' | 'sms'; completedAt: string | null } | null = null
  if (call) {
    resolved = { source: 'call', completedAt: call.photos_completed_at as string | null }
  } else {
    const { data: convo } = await supabase
      .from('sms_conversations')
      .select('id, photo_request_token, photos_completed_at')
      .eq('photo_request_token', token)
      .maybeSingle()
    if (convo) {
      resolved = { source: 'sms', completedAt: convo.photos_completed_at as string | null }
    }
  }

  if (!resolved) {
    return (
      <Wrap>
        <h1 style={{ fontSize: '1.4rem', marginBottom: '0.5rem' }}>Link not found</h1>
        <p style={{ color: '#555' }}>This upload link is invalid or has expired. Reply to your QuoteMate SMS if you need a new one.</p>
      </Wrap>
    )
  }

  if (resolved.completedAt) {
    return (
      <Wrap>
        <h1 style={{ fontSize: '1.4rem', marginBottom: '0.5rem' }}>Photos already received</h1>
        <p style={{ color: '#555' }}>Thanks — your photos are with us. Your quote will arrive by SMS shortly if it hasn't already.</p>
      </Wrap>
    )
  }

  return (
    <Wrap>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '0.5rem' }}>Add photos for your quote</h1>
      <p style={{ color: '#555', marginBottom: '1.25rem', lineHeight: 1.5 }}>
        A photo or two of the area helps us spot anything tricky and lock in the price. Up to 5 photos, JPEG or PNG.
      </p>
      <UploadForm token={token} />
    </Wrap>
  )
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <main style={{
      fontFamily: 'system-ui, -apple-system, sans-serif',
      maxWidth: 480, margin: '2rem auto', padding: '0 1rem', color: '#111',
    }}>
      {children}
    </main>
  )
}

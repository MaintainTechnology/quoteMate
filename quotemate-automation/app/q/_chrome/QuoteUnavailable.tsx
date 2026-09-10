export function QuoteUnavailable({ correlationId }: { correlationId: string }) {
  return <main style={{ maxWidth: 620, margin: '80px auto', padding: 24 }}>
    <h1>Your quote is temporarily unavailable</h1>
    <p>We couldn’t load your quote just now. Your link may still be valid. Please try again shortly.</p>
    <a href="">Try again</a>
    <p style={{ fontSize: 12 }}>Support reference: {correlationId}</p>
  </main>
}

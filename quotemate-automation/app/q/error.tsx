'use client'

export default function QuoteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main style={{ maxWidth: 620, margin: '80px auto', padding: 24 }}>
    <h1>Your quote is temporarily unavailable</h1>
    <p>We couldn’t load your quote just now. Please try again shortly.</p>
    <button type="button" onClick={reset}>Try again</button>
    {error.digest && <p>Support reference: {error.digest}</p>}
  </main>
}

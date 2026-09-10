/** Held drafts contain no customer-visible price or priced download link. */
export function QuoteAwaitingReview() {
  return <main style={{ maxWidth: 620, margin: '80px auto', padding: 24 }}>
    <h1>Your quote is awaiting approval</h1>
    <p>Your tradie needs to review and approve this quote before the price can be shared.</p>
    <p>You can use this same link after approval.</p>
  </main>
}

import { afterEach, describe, it, expect, vi } from 'vitest'
import { repairQuoteLinks } from './dialog'
import { guardGeneratedQuoteLinks, canonicalQuoteUrl, QUOTE_FAMILIES } from './quote-actions'

afterEach(() => vi.unstubAllEnvs())

describe('canonical quote URL authority', () => {
  const known = 'https://quotemax.com.au/q/roof/saved_token_123456'
  it('rejects a transcript link even if inbound and model agree on the token', () => {
    expect(repairQuoteLinks(`Here: ${known}`, known)).not.toContain(known)
  })
  it('does not guess a corrupted token from a similar or lone history link', () => {
    expect(repairQuoteLinks(`Here: ${known}x`, known, [known])).not.toContain('https://')
  })
  it('permits exactly the server-resolved URL and its trailing punctuation', () => {
    expect(repairQuoteLinks(`Here: ${known}.`, '', [known])).toBe(`Here: ${known}.`)
  })
  it('strips invented, cross-family, different-host and model-added query URLs', () => {
    for (const url of [known+'?s=999', known.replace('/roof/','/solar/'), known.replace('quotemax.com.au','evil.example'), known+'x']) {
      expect(guardGeneratedQuoteLinks(url, [known])).not.toContain('https://')
    }
  })
  it('builds every family only from a valid persisted reference with no model query', () => {
    for (const family of QUOTE_FAMILIES) {
      expect(canonicalQuoteUrl({ family, id: 'saved', token: 'saved_token_12345', label: 'job', stage: 'ready', createdAt: '' }, 'https://quotemax.com.au'))
        .toBe(`https://quotemax.com.au/q/${family === 'generic' ? '' : family+'/'}saved_token_12345`)
    }
  })
  it('rejects encoded paths, invented external destinations and scheme-less links',()=>{
    for(const url of ['https://quotemax.com.au/%71/other_token','https://invented.example/customer/123','//quotemax.com.au/q/other_token','www.quotemax.com.au/q/other_token']) {
      expect(guardGeneratedQuoteLinks(url,[known])).not.toContain('quotemax.com.au')
      expect(guardGeneratedQuoteLinks(url,[known])).not.toContain('invented.example')
    }
  })
  it('rejects path traversal and API origins at the canonical builder', () => {
    // Exercise APP_URL fallback independently of the host's configured website.
    vi.stubEnv('PUBLIC_WEB_ORIGIN', '')
    const reference = { family: 'roof' as const, id: 'id', token: '../other', label: 'job', stage: 'ready' as const, createdAt: '' }
    expect(() => canonicalQuoteUrl(reference, 'https://quotemax.com.au')).toThrow()
    expect(() => canonicalQuoteUrl({ ...reference, token: 'valid_token_1234' }, 'https://qm-roof-production.up.railway.app')).toThrow()
  })
  it('keeps the configured website authoritative when a caller supplies an API fallback', () => {
    vi.stubEnv('PUBLIC_WEB_ORIGIN', 'https://quotemax.com.au')
    expect(canonicalQuoteUrl({ family: 'roof', id: 'saved', token: 'valid_token_1234', label: 'job', stage: 'ready', createdAt: '' },
      'https://qm-roof-production.up.railway.app')).toBe('https://quotemax.com.au/q/roof/valid_token_1234')
  })
  it('rejects bare hosts and relative quote paths without altering ordinary text or email', () => {
    for (const url of ['quotemax.com.au/q/invented_token_12345', 'invented.example/quote/123', '/q/invented_token_12345', '/q/solar/invented_token_12345', '/api/q/invented_token_12345/pdf', '/%71/invented_token_12345', '/r/invented_token_12345/better']) {
      expect(guardGeneratedQuoteLinks(`Here: ${url}.`, [known])).toBe('Here: [saved link needs verification].')
    }
    expect(guardGeneratedQuoteLinks('Email hello@example.com about the 2.5 metre wall.')).toBe('Email hello@example.com about the 2.5 metre wall.')
    expect(guardGeneratedQuoteLinks('Email hello@company.com.au or sam@trade.example.co.nz.')).toBe('Email hello@company.com.au or sam@trade.example.co.nz.')
    expect(guardGeneratedQuoteLinks(`Here: <${known}>`, [known])).toBe(`Here: <${known}>`)
  })
})

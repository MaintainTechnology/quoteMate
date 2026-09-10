import { describe,expect,it } from 'vitest'
import { publicWebOrigin,publicWebUrl } from './public-origin'
describe('canonical website origin',()=>{
  it.each([undefined,'http://quotemax.com.au','https://qm-electrical-receptionist-production.up.railway.app','http://localhost:3000','https://127.0.0.1','https://user:pass@quotemax.com.au','https://quotemax.com.au/path','https://quotemax.com.au?token=oops'])('fails closed on %s',APP_URL=>{
    expect(()=>publicWebOrigin({NODE_ENV:'production',APP_URL})).toThrow()
  })
  it('keeps all link families on one website and rejects an engine origin',()=>{
    const env={NODE_ENV:'production' as const,PUBLIC_WEB_ORIGIN:'https://quotemax.com.au',ENGINE_BASE_URL:'http://localhost:8080'}
    for(const family of ['','roof/','paint/','solar/','plan/','aircon/','commercial-paint/']) expect(publicWebUrl(`/q/${family}saved-token`,env)).toBe(`https://quotemax.com.au/q/${family}saved-token`)
    expect(()=>publicWebOrigin({...env,ENGINE_BASE_URL:'https://quotemax.com.au'})).toThrow()
    expect(()=>publicWebUrl('//evil.test',env)).toThrow()
  })
  it('treats blank generated optional variables as absent when APP_URL is configured',()=>{
    expect(publicWebOrigin({NODE_ENV:'production',PUBLIC_WEB_ORIGIN:'  ',APP_URL:' https://quotemax.com.au '})).toBe('https://quotemax.com.au')
    expect(publicWebOrigin({NODE_ENV:'production',PUBLIC_WEB_ORIGIN:'',APP_URL:'',NEXT_PUBLIC_APP_URL:'https://quotemax.com.au'})).toBe('https://quotemax.com.au')
    expect(()=>publicWebOrigin({NODE_ENV:'production',PUBLIC_WEB_ORIGIN:' ',APP_URL:''})).toThrow()
  })
})

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
vi.mock('@/lib/storage/upload',()=>({uploadIntakePhoto:vi.fn(async()=>({signedUrl:'https://storage.test/photo',path:'conversation/photo'}))}))
import { uploadIntakePhoto } from '@/lib/storage/upload'
import { extractAndStoreMmsPhotos, authorisedTwilioMediaUrl } from './mms'
const sid='AC'+'a'.repeat(32)
const media=`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages/SM${'b'.repeat(32)}/Media/ME${'c'.repeat(32)}`
let png: Uint8Array<ArrayBuffer>, webp: Uint8Array<ArrayBuffer>
beforeAll(async()=>{
  const image=sharp({create:{width:1,height:1,channels:3,background:'#ffffff'}})
  png=new Uint8Array(await image.clone().png().toBuffer())
  webp=new Uint8Array(await image.clone().webp().toBuffer())
})
beforeEach(()=>{vi.stubEnv('TWILIO_ACCOUNT_SID',sid);vi.stubEnv('TWILIO_AUTH_TOKEN','test-secret');vi.mocked(uploadIntakePhoto).mockClear()})
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs()})
function extract(type='image/png',url=media) { return extractAndStoreMmsPhotos({conversationId:'conversation',params:{NumMedia:'1',MediaUrl0:url,MediaContentType0:type}}) }
describe('MMS provider boundary',()=>{
  it.each(['https://attacker.example/x','http://127.0.0.1/x','https://api.twilio.com.attacker.example/x',media.replace(sid,'AC'+'d'.repeat(32))])('rejects untrusted authenticated fetch %s',async url=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
    expect((await extract('image/png',url)).attempts[0].ok).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('passes credentials only to canonical account URL and never a CDN redirect',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{status:307,headers:{location:`https://mms.twiliocdn.com/${sid}/signed`}}))
      .mockResolvedValueOnce(new Response(png))
    vi.stubGlobal('fetch',fetcher)
    expect((await extract()).attempts[0]).toMatchObject({ok:true,contentType:'image/png'})
    expect(fetcher.mock.calls[0][1].headers.Authorization).toMatch(/^Basic /)
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBeUndefined()
    expect(fetcher.mock.calls[0][1].redirect).toBe('manual')
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
  it('rejects redirect escape without requesting it',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location:'https://attacker.example/private'}}))
    vi.stubGlobal('fetch',fetcher)
    expect((await extract()).attempts[0].ok).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('preserves WebP bytes and rejects mislabeled non-images',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(webp)))
    expect((await extract('image/webp')).attempts[0]).toMatchObject({ok:true,contentType:'image/webp'})
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<script>bad</script>')))
    expect((await extract()).attempts[0].ok).toBe(false)
    expect(uploadIntakePhoto).toHaveBeenCalledTimes(1)
  })
  it('bounds streamed bytes even without content-length',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(new Uint8Array(5*1024*1024+1))))
    expect((await extract()).attempts[0]).toMatchObject({ok:false,reason:'Media exceeds 5 MB'})
    expect(uploadIntakePhoto).not.toHaveBeenCalled()
  })
  it('rejects truncated content even when its magic bytes look valid',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(png.slice(0,12))))
    expect((await extract()).attempts[0].ok).toBe(false)
    expect(uploadIntakePhoto).not.toHaveBeenCalled()
  })
  it('accepts only the media resource path, never another account API endpoint',()=>{
    expect(()=>authorisedTwilioMediaUrl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,sid)).toThrow()
  })
})

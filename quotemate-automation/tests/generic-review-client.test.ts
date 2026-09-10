import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
import {it,expect,vi} from 'vitest'
type Node={type:unknown;props:Record<string,unknown>}
function client(file:string,name:string,props:Record<string,unknown>){
  const values:unknown[]=[];let cursor=0
  const fetch=vi.fn(async(_url:string,_options:RequestInit)=>{void _url;void _options;return Response.json({ok:true,accepted:true})})
  const exports:Record<string,unknown>={}
  const jsx=(type:unknown,p:Record<string,unknown>)=>({type,props:p})
  const compiled=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText
  runInNewContext(compiled,{exports,module:{exports},fetch,crypto:{randomUUID:()=> '33333333-3333-4333-8333-333333333333'},console,
    require:(module:string)=>{
      if(module==='react/jsx-runtime')return {jsx,jsxs:jsx}
      if(module==='@/lib/auth/client-token')return {getAuthToken:async()=> 'fresh-owner-token'}
      if(module==='react')return {
        useEffect:(effect:()=>unknown)=>{const key=cursor++;if(!(key in values)){values[key]=true;effect()}},
        useRef:(value:unknown)=>{const key=cursor++;if(!(key in values))values[key]={current:value};return values[key]},
        useState:(value:unknown)=>{const key=cursor++;if(!(key in values))values[key]=value;return [values[key],(next:unknown)=>{values[key]=typeof next==='function'?next(values[key]):next}]},
      }
      throw new Error(module)
    },
  })
  function render(){cursor=0;return (exports[name] as (props:Record<string,unknown>)=>Node)(props)}
  return {render,fetch}
}
function find(node:unknown,test:(node:Node)=>boolean):Node|undefined {
  if(!node || typeof node!=='object')return
  if(Array.isArray(node)){for(const child of node){const result=find(child,test);if(result)return result}return}
  const current=node as Node;if(test(current))return current
  return find(current.props?.children,test)
}
async function click(tree:Node,label:string){const node=find(tree,n=>n.type==='button'&&n.props.children===label);expect(node,`button ${label}`).toBeTruthy();await (node!.props.onClick as ()=>Promise<void>)()}
it('actual ApproveAction submits the displayed revision with a fresh owner token',async()=>{
  const ui=client('app/q/[token]/approve/ApproveAction.tsx','ApproveAction',{quoteId:'quote-1',shareToken:'saved-token',reviewVersion:'displayed-revision',customerPhone:'0411 111 111'})
  const button=find(ui.render(),node=>node.type==='button')!
  await (button.props.onClick as ()=>Promise<void>)()
  const options=ui.fetch.mock.calls[0][1] as RequestInit
  expect(JSON.parse(String(options.body))).toEqual({expected_revision:'displayed-revision',expected_recipient:'0411 111 111'})
  expect(options.headers).toMatchObject({Authorization:'Bearer fresh-owner-token'})
})
it('actual SendQuotePanel submits the reviewed revision and preserves a deliberate resend ID across network retries',async()=>{
  const ui=client('app/dashboard/quote/[token]/SendQuotePanel.tsx','default',{quoteId:'quote-1',customerPhone:'+61411111111',customerEmail:'customer@example.com',paid:false,reviewVersion:'displayed-revision'})
  await click(ui.render(),'Send to Customer')
  await click(ui.render(),'Send SMS')
  const first=JSON.parse(String((ui.fetch.mock.calls[0][1] as RequestInit).body))
  expect(first.expected_revision).toBe('displayed-revision');expect(first.requestId).toBeUndefined()
  expect(first.expected_recipient).toBe('+61411111111');expect(first.to).toBeUndefined()
  ui.fetch.mockRejectedValueOnce(new Error('response lost'))
  await click(ui.render(),'Send SMS again')
  await click(ui.render(),'Send SMS')
  const second=JSON.parse(String((ui.fetch.mock.calls[1][1] as RequestInit).body))
  const retry=JSON.parse(String((ui.fetch.mock.calls[2][1] as RequestInit).body))
  expect(second.requestId).toBe('33333333-3333-4333-8333-333333333333');expect(retry).toEqual(second)
})
it('a fresh already-sent viewer creates an explicit resend ID and known pending delivery requires recovery',async()=>{
  const ui=client('app/dashboard/quote/[token]/SendQuotePanel.tsx','default',{quoteId:'quote-1',customerPhone:'+61411111111',customerEmail:null,paid:false,reviewVersion:'review',sentBefore:true})
  ui.fetch.mockResolvedValueOnce(Response.json({ok:true,accepted:false},{status:202}))
  await click(ui.render(),'Send to Customer');await click(ui.render(),'Send SMS')
  expect(JSON.parse(String((ui.fetch.mock.calls[0][1] as RequestInit).body)).requestId).toBe('33333333-3333-4333-8333-333333333333')
  const tree=ui.render();expect(find(tree,n=>n.type==='a'&&n.props.href==='/dashboard/sms-delivery')).toBeTruthy()
  const button=find(tree,n=>n.type==='button'&&n.props.children==='Send SMS again')!
  expect(button.props.disabled).toBe(true);await (button.props.onClick as ()=>Promise<void>)();expect(ui.fetch).toHaveBeenCalledTimes(1)
})

it.each(['+61422222222',null])('a lost SMS response keeps the reviewed recipient and revision when on-file phone becomes %s',async updatedPhone=>{
  const props={quoteId:'quote-1',customerPhone:'+61411111111' as string | null,customerEmail:null,paid:false,reviewVersion:'review-a',sentBefore:true}
  const ui=client('app/dashboard/quote/[token]/SendQuotePanel.tsx','default',props)
  ui.fetch.mockRejectedValueOnce(new Error('lost after acceptance'))
  await click(ui.render(),'Send to Customer');await click(ui.render(),'Send SMS')
  props.customerPhone=updatedPhone;props.reviewVersion='review-b'
  expect(find(ui.render(),n=>n.props.children==='+61411111111')).toBeTruthy()
  expect(find(ui.render(),n=>n.type==='button'&&n.props.children==='Send SMS')?.props.disabled).toBe(false)
  await click(ui.render(),'Send SMS')
  const bodies=ui.fetch.mock.calls.map(call=>JSON.parse(String((call[1] as RequestInit).body)))
  expect(bodies[1]).toEqual(bodies[0])
  expect(bodies[1]).toMatchObject({expected_recipient:'+61411111111',expected_revision:'review-a',requestId:'33333333-3333-4333-8333-333333333333'})
})

it('an explicit typed SMS destination is both the override and the reviewed recipient',async()=>{
  const ui=client('app/dashboard/quote/[token]/SendQuotePanel.tsx','default',{quoteId:'quote-1',customerPhone:null,customerEmail:null,paid:false,reviewVersion:'review'})
  await click(ui.render(),'Send to Customer')
  const input=find(ui.render(),n=>n.type==='input'&&n.props.type==='tel')!
  ;(input.props.onChange as (event:unknown)=>void)({target:{value:'0411 222 333'}})
  await click(ui.render(),'Send SMS')
  expect(JSON.parse(String((ui.fetch.mock.calls[0][1] as RequestInit).body))).toMatchObject({to:'0411 222 333',expected_recipient:'0411 222 333'})
})

it.each([false,true])('email sends the reviewed value and preserves explicit override semantics (%s)',async override=>{
  const ui=client('app/dashboard/quote/[token]/SendQuotePanel.tsx','default',{quoteId:'quote-1',customerPhone:null,customerEmail:'Customer@EXAMPLE.COM',paid:false,reviewVersion:'review'})
  await click(ui.render(),'Send to Customer')
  if(override){const input=find(ui.render(),n=>n.type==='input'&&n.props.type==='email')!;(input.props.onChange as (event:unknown)=>void)({target:{value:'other@example.com'}})}
  await click(ui.render(),'Send Email')
  const body=JSON.parse(String((ui.fetch.mock.calls[0][1] as RequestInit).body))
  expect(body.expected_recipient).toBe(override?'other@example.com':'Customer@EXAMPLE.COM')
  expect(body.to).toBe(override?'other@example.com':undefined)
})

it.each(['sms','email'])('a changed %s recipient requires manual review without an automatic or repeated send',async channel=>{
  const ui=client('app/dashboard/quote/[token]/SendQuotePanel.tsx','default',{quoteId:'quote-1',customerPhone:'+61411111111',customerEmail:'customer@example.com',paid:false,reviewVersion:'review'})
  ui.fetch.mockResolvedValueOnce(Response.json({error:'quote_recipient_changed'},{status:409}))
  await click(ui.render(),'Send to Customer')
  const label=channel==='sms'?'Send SMS':'Send Email'
  await click(ui.render(),label)
  const tree=ui.render()
  expect(find(tree,n=>n.type==='button'&&n.props.children===label)?.props.disabled).toBe(true)
  expect(find(tree,n=>n.type==='button'&&n.props.children==='Refresh and review contact')).toBeTruthy()
  await click(tree,label)
  expect(ui.fetch).toHaveBeenCalledTimes(1)
})

it('approval contact mismatch keeps send disabled until the owner opens a fresh review',async()=>{
  const ui=client('app/q/[token]/approve/ApproveAction.tsx','ApproveAction',{quoteId:'quote-1',shareToken:'saved-token',reviewVersion:'review',customerPhone:'+61411111111'})
  ui.fetch.mockResolvedValueOnce(Response.json({error:'quote_recipient_changed'},{status:409}))
  await (find(ui.render(),n=>n.type==='button')!.props.onClick as ()=>Promise<void>)()
  const tree=ui.render()
  expect(find(tree,n=>n.type==='button')?.props.disabled).toBe(true)
  expect(find(tree,n=>n.type==='a'&&n.props.href==='/q/saved-token/approve')).toBeTruthy()
  await (find(tree,n=>n.type==='button')!.props.onClick as ()=>Promise<void>)()
  expect(ui.fetch).toHaveBeenCalledTimes(1)
})

it.each(['+61422222222',null])('a lost approval response retains its reviewed recipient when on-file phone becomes %s',async updatedPhone=>{
  const props={quoteId:'quote-1',shareToken:'saved-token',reviewVersion:'review-a',customerPhone:'+61411111111' as string | null}
  const ui=client('app/q/[token]/approve/ApproveAction.tsx','ApproveAction',props)
  ui.fetch.mockRejectedValueOnce(new Error('response lost'))
  await (find(ui.render(),n=>n.type==='button')!.props.onClick as ()=>Promise<void>)()
  props.customerPhone=updatedPhone;props.reviewVersion='review-b'
  expect(find(ui.render(),n=>n.type==='button')?.props.disabled).toBe(false)
  await (find(ui.render(),n=>n.type==='button')!.props.onClick as ()=>Promise<void>)()
  const bodies=ui.fetch.mock.calls.map(call=>JSON.parse(String((call[1] as RequestInit).body)))
  expect(bodies[1]).toEqual(bodies[0])
  expect(bodies[1]).toEqual({expected_recipient:'+61411111111',expected_revision:'review-a'})
})

it('approval without a reviewed phone cannot send even if its handler is invoked',async()=>{
  const ui=client('app/q/[token]/approve/ApproveAction.tsx','ApproveAction',{quoteId:'quote-1',shareToken:'saved-token',reviewVersion:'review',customerPhone:null})
  const tree=ui.render();expect(find(tree,n=>n.type==='button')?.props.disabled).toBe(true)
  await (find(tree,n=>n.type==='button')!.props.onClick as ()=>Promise<void>)()
  expect(ui.fetch).not.toHaveBeenCalled()
})

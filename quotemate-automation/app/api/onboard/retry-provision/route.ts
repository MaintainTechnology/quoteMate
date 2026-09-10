import { createClient } from '@supabase/supabase-js'
import { runProvisioning } from '@/lib/onboard/run-provisioning'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { PROVISIONING_TENANT_FIELDS, readProvisioningStatus, type ProvisioningTenant } from '@/lib/onboard/provisioning-status'

export const dynamic = 'force-dynamic'
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!)
type Tenant = ProvisioningTenant & { business_name?:string; owner_first_name?:string; owner_mobile?:string; trade?:string; trades?:string[] }

/** Only a tenant with no prior attempt or artifact can start provider work.
 * Existing attempts, including abandoned processing, are read-only here. */
export async function POST(req:Request) {
  try {
    const resolved=await resolveTenantRequest(supabase,req,`${PROVISIONING_TENANT_FIELDS},business_name,owner_first_name,owner_mobile,trade,trades`)
    if(!resolved) return Response.json({ok:false,error:'unauthorized'},{status:401})
    if(!resolved.tenant) return Response.json({ok:false,error:'no_tenant'},{status:404})
    const tenant=resolved.tenant as Tenant
    const before=await readProvisioningStatus(supabase,tenant)
    if(!before.retryable) return Response.json({ok:before.state==='ready'||before.state==='stub',tenantId:tenant.id,
      setupComplete:before.setupComplete,phoneReadiness:before,phoneNumber:before.phoneNumber,
      provisioningMode:before.provisioningMode,warning:before.setupComplete?undefined:before.message}, {headers:{'Cache-Control':'no-store'}})
    const trades=tenant.trades?.length ? tenant.trades:[tenant.trade??'electrical']
    const result=await runProvisioning(supabase,{tenantId:tenant.id,businessName:tenant.business_name??'',
      trade:trades[0],trades,ownerFirstName:tenant.owner_first_name??'mate',ownerMobile:tenant.owner_mobile??null})
    return Response.json({ok:result.ok,tenantId:tenant.id,setupComplete:result.phoneReadiness?.setupComplete===true,
      phoneReadiness:result.phoneReadiness,phoneNumber:result.phoneNumber,
      provisioningMode:result.phoneReadiness?.provisioningMode,warning:result.error??result.warning}, {headers:{'Cache-Control':'no-store'}})
  } catch {
    return Response.json({ok:false,error:'provisioning_status_unavailable',setupComplete:false},{status:503,headers:{'Cache-Control':'no-store'}})
  }
}

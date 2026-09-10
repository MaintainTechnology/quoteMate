import { createClient } from '@supabase/supabase-js'
import { resolveTenantRequest } from '@/lib/tenant/from-request'
import { PROVISIONING_TENANT_FIELDS, readProvisioningStatus, type ProvisioningTenant } from '@/lib/onboard/provisioning-status'
export const dynamic='force-dynamic'
const supabase=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!)
export async function GET(req:Request) {
  const headers={'Cache-Control':'no-store'}
  try {
    const resolved=await resolveTenantRequest(supabase,req,PROVISIONING_TENANT_FIELDS)
    if(!resolved) return Response.json({ok:false,error:'unauthorized'},{status:401,headers})
    if(!resolved.tenant) return Response.json({ok:false,error:'no_tenant'},{status:404,headers})
    const phoneReadiness=await readProvisioningStatus(supabase,resolved.tenant as ProvisioningTenant)
    return Response.json({ok:true,tenantId:phoneReadiness.tenantId,phoneReadiness},{headers})
  } catch {
    return Response.json({ok:false,error:'provisioning_status_unavailable'},{status:503,headers})
  }
}

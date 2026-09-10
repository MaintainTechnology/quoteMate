import type { SupabaseClient } from '@supabase/supabase-js'

/** Approval/send recovery requires migration 202 even when no jobs exist yet. */
export const JOB_QUOTE_OPERATION_SCHEMA = 'tenant_id,operation_id,request_hash,intake_id,quote_id,status,pinned,pin_requested,created_at,updated_at'

/** Release/readiness probes read zero rows and validate the website's token contracts. */
export const PUBLIC_QUOTE_SCHEMA = [
  { family:'generic', table:'quotes', select:'id,intake_id,tenant_id,status,scope_of_works,assumptions,risk_flags,good,better,best,optional_upsells,estimated_timeframe,needs_inspection,inspection_reason,inspection_cause,gst_note,selected_tier,share_token,stripe_links,paid_at,paid_tier,created_at,price_hold_until,booking_state,preview_status,preview_image_path,preview_image_paths,samples_status,sample_image_paths,display_mode,deposit_pct,total_inc_gst,quote_kind,parent_quote_id,customer_released_at,sent_at' },
  { family:'roof', table:'roofing_measurements', select:'tenant_id,address,state,provider,routing,combined_area_m2,quote,public_token,confirmed_at,confirmed_structure,included_indices,released_at,quote_share_token,paid_at' },
  { family:'paint', table:'painting_measurements', select:'address,postcode,state,scopes,confidence,routing,estimate,public_token,customer_name,created_at,tenant_id,preview_status,released_at,tenants:tenant_id(business_name)' },
  { family:'solar', table:'solar_estimates', select:'public_token,tenant_id,estimate,confirmed_at' },
  { family:'plan', table:'plan_extractions', select:'id,items,corrected_items,sheets_used,overall_note,priced_bom,report_pdf_path,created_at,tenant_id,share_token,released_at,plan_uploads(filename),tenants:tenant_id(business_name)' },
  { family:'aircon', table:'aircon_recommendations', select:'address,postcode,state,recommendation,created_at,tenant_id,public_token,released_at,tenants:tenant_id(business_name,trade)' },
  { family:'commercial-paint', table:'paint_runs', select:'id,job_name,site_address,status,created_at,public_token,tenant_id,released_at,tenants:tenant_id(business_name)' },
] as const
export async function verifyPublicQuoteSchema(db: SupabaseClient) {
  const families = await Promise.all(PUBLIC_QUOTE_SCHEMA.map(async contract => {
    try {
      const result = await db.from(contract.table).select(contract.select).limit(0).abortSignal(AbortSignal.timeout(3_000))
      return { family:contract.family, ready:!result.error, errorCode:result.error?.code ?? null }
    } catch { return {family:contract.family,ready:false,errorCode:'DEPENDENCY_FAILURE'} }
  }))
  return { ready:families.every(family=>family.ready), families }
}

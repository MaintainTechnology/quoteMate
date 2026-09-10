-- Read-only compatibility for the reviewed quote-chain writers. This migration
-- never calls those writers. A missing source, signature, permission or schema
-- dependency is not a quoting-ready installation.
-- Reviewed 219/220/221 bodies are pinned. This catalog probe may install first,
-- but stays false until compatible 219/220/221 dependencies are present.
-- It never invokes a business writer.
-- Fingerprints normalize CRLF to LF only; whitespace inside SQL/string literals
-- remains significant. See the source-bound SQL regression test.
begin;

create or replace function public.sms_quote_chain_ready()
returns boolean language sql stable security invoker set search_path=pg_catalog as $readiness$
  with required_functions(signature,arg_names,default_count,defaults,body_sha256,result_type,definer,execute_policy) as (values
    ('public.prepare_balance_quote(uuid,uuid,jsonb,jsonb,jsonb,bigint,text)',
      array['p_final_id','p_tenant_id','p_final_snapshot','p_root_snapshot','p_intake_snapshot','p_balance_cents','p_share_token'],
      0,null::text,'fb4f363f4bdcc3fe1317bdba8ec346663b98ae3ef7a82ebbb18a389e6a82fbe9','jsonb',true,'service_only'),
    ('public.prepare_final_quote(uuid,uuid,jsonb,jsonb,jsonb,uuid)',
      array['p_parent_id','p_tenant_id','p_parent_snapshot','p_intake_snapshot','p_child','p_deposit_version_id'],
      2,'NULL::jsonb, NULL::uuid','68611245fffd6a6a298b2a18f1411ef32c8c48e406970adc62a089d3568ea4ac','jsonb',true,'service_only'),
    ('public.approve_generic_quote_release(uuid,uuid,text,jsonb,timestamptz,jsonb,text)',
      array['p_quote_id','p_tenant_id','p_owner_id','p_snapshot','p_hold_until','p_outbound','p_hash'],
      2,'NULL::jsonb, NULL::text','54eef380454785d8dc7cec388f6a97511b572981ad422324e2c72f6dd7d0e8b4','jsonb',true,'service_only'),
    ('public.settle_final_quote_credit(uuid,uuid)',array['p_outbox_id','p_tenant_id'],0,null::text,
      '240e48677496382a5e9788239cfff44a931cb187e2244f1f86c24d98be2a4364','jsonb',true,'service_only'),
    ('public.reflect_final_quote_credit()',null::text[],0,null::text,
      '6de0880505360f465e9278946f4ca073c85f98b6d9e22a4d15ebab42346a7be8','trigger',true,'owner_only'),
    ('public.sms_outbox_enqueue(text,jsonb,text)',array['p_key','p_payload','p_hash'],0,null::text,
      '8959baf87d2e5d81dba30a168cc765bfa6c2db56dbf05bbd179cb876615013f1','jsonb',true,'service_only'),
    -- Pin direct safety dependencies, including their distinct existing ACLs.
    -- This migration does not change historical writer/trigger permissions.
    ('public.reflect_generic_quote_delivery()',null::text[],0,null::text,
      '00c3a11f746eed42a3cc3a5286914b071b145cfe325c6e410637f5c1d5bcf53b','trigger',true,'owner_public'),
    ('public.guard_quote_pricing_version()',null::text[],0,null::text,
      'e304f45554d576d374936b9d2ab7ed785ae048311b0dd943fae1b76fe4659bc6','trigger',false,'owner_only'),
    ('public.guard_quote_pricing_version_owner()',null::text[],0,null::text,
      '2e4fc196975da5aeadcf8e496f6afff0bc7c51d798c95d06972790d023091a9e','trigger',false,'owner_only'),
    ('public.capture_quote_pricing_version(uuid,text,uuid,jsonb)',array['p_tenant_id','p_trade','p_book_id','p_expected_book'],0,null::text,
      'f2e8170b65d2da18dbf0bfebe468ad5b9d723fc23d86e0f6398be1d330307e8e','jsonb',true,'service_only'),
    ('public.commercial_paint_pricing_source(uuid,uuid,uuid)',array['p_tenant_id','p_run_id','p_extraction_id'],0,null::text,
      'f03af634edb911ea7ecb8724a1da1223fbd9f7beace74c3bbe35a728eef6ae42','jsonb',false,'service_only'),
    ('public.persist_commercial_paint_pricing(uuid,uuid,uuid,jsonb,jsonb,jsonb)',
      array['p_tenant_id','p_run_id','p_extraction_id','p_source','p_proof','p_bom'],0,null::text,
      '973797a9f7ee6d4f56071c1cf206bc52edd69c2212744ef2941c9a9cd94c2bb5','jsonb',false,'service_only'),
    ('public.save_commercial_paint_quote(uuid,uuid,uuid,jsonb,jsonb,jsonb,timestamptz,jsonb,jsonb)',
      array['p_tenant_id','p_run_id','p_extraction_id','p_source','p_proof','p_bom','p_priced_at','p_intake','p_quote'],0,null::text,
      '039e2730b98298411136a53d3268f50f3f00e0a0ce32d23889643fa4f833cd27','jsonb',false,'service_only'),
    ('public.followup_outbox_matches(public.followup_operations,public.sms_outbox)',array['op','box'],0,null::text,
      'cbc96c2102d56488c274b8d9f301805c5f344f16b6445a9e0255aa3ac53b363b','boolean',false,'owner_only'),
    ('public.followup_outbox_accepted(public.sms_outbox)',array['box'],0,null::text,
      '1e2675c8a4bef9aec1b9681828d7a8d30b59dbd59c05833d936026fd0728a509','boolean',false,'owner_only'),
    ('public.followup_operation_claim(uuid,uuid,text,text,uuid,text,jsonb)',
      array['p_tenant','p_request','p_action','p_target_kind','p_target','p_hash','p_payload'],0,null::text,
      'ee40fa60f77e0079e642d15eac22d89b9fa2ada4ab0a5d030d95fe012aedcc44','jsonb',true,'service_only'),
    ('public.followup_operation_repair(uuid,uuid)',array['p_tenant','p_request'],0,null::text,
      '4f7c010e6e621756d3ce214777619f2232460eee2bcee548bd2146f96b7b42bf','jsonb',true,'service_only'),
    ('public.followup_operation_try_repair(uuid,uuid)',array['p_tenant','p_request'],0,null::text,
      '1fb6d699136900cb391d7ed1fea792da0c0b3be70a0861970e44504adae1c340','void',true,'service_only'),
    ('public.followup_outbox_evidence()',null::text[],0,null::text,
      '39584a917ab70c531ec52c68e19bdc56d5d9ab945317209351bd1c196c36a8dd','trigger',true,'owner_only'),
    ('public.followup_call_finish(uuid,uuid,text,text)',array['p_tenant','p_request','p_status','p_sid'],0,null::text,
      'f3d2b4820c82f6a7f9a545033570e61ae1108efb4da557bd746ed81b03ee2172','jsonb',true,'service_only'),
    ('public.followup_note_commit(uuid,uuid,uuid,text,jsonb)',array['p_tenant','p_request','p_quote','p_hash','p_payload'],0,null::text,
      '2bf9fdae244548424026684597afae791330b510b59915f0a0509629606c6a90','jsonb',true,'service_only'),
    ('public.commercial_paint_edit_snapshot(uuid,uuid)',array['p_tenant_id','p_run_id'],0,null::text,
      '507378895bca7847e6e7e5f7f4873de3903b291f63ee328f51992486a5162899','jsonb',false,'service_only'),
    ('public.commercial_paint_valid_correction(jsonb)',array['p_changes'],0,null::text,
      '5986f6a6d27fb364eb394d3c4b936a372f6bdee6acac4467f4b66a9e6b08faa0','boolean',false,'service_only'),
    ('public.commercial_paint_correction_status(uuid,uuid,uuid)',array['p_tenant_id','p_run_id','p_operation_id'],0,null::text,
      '403e3c247cc6072ffbebfab4ef0b1e3c25c515e309785df42051b406f241a1f0','jsonb',false,'service_only'),
    ('public.apply_commercial_paint_correction(uuid,uuid,uuid,text,uuid,text,jsonb)',
      array['p_tenant_id','p_run_id','p_operation_id','p_expected_revision','p_extraction_id','p_request_hash','p_changes'],0,null::text,
      '64bf257747e0769846c9330fd4b65e0f9a045a7f2d118d3491673d6643e3f95c','jsonb',false,'service_only'),
    ('public.sms_release_quote_resource(uuid,text,uuid,text,jsonb,text,jsonb)',
      array['p_tenant_id','p_family','p_resource_id','p_customer_phone','p_outbound','p_outbound_hash','p_expected_snapshot'],
      4,'NULL::text, NULL::jsonb, NULL::text, NULL::jsonb','a9843baa09f0531c3aa00d0f3c981de89fcc82c61817c7aed046d0febd1c02ab','jsonb',true,'service_only'),
    ('public.guard_commercial_quote_extraction()',null::text[],0,null::text,
      'e436b1e804aedfc08d32e6bca4d18ee49eeee44eb37819608e2b767e1aa966a6','trigger',false,'owner_only'),
    ('public.guard_commercial_quote_run()',null::text[],0,null::text,
      '1d08363a4c3ae995f0eb6bc31fda10380cae584931644b53fa7b958182f9dc6c','trigger',false,'owner_only'),
    ('public.sms_normalise_customer_phone(text)',array['p_phone'],0,null::text,
      '85f548cdb40a09312fdd02711efca34bcc2985f57347391062699867391163d7','text',false,'owner_public')
  ), required_columns(table_name,column_name,type_name) as (values
    ('quotes','id','uuid'),('quotes','tenant_id','uuid'),('quotes','intake_id','uuid'),
    ('quotes','parent_quote_id','uuid'),('quotes','pricing_book_version_id','uuid'),
    ('quotes','quote_kind','text'),('quotes','share_token','text'),('quotes','status','text'),
    ('quotes','paid_tier','text'),('quotes','paid_at','timestamptz'),('quotes','sent_at','timestamptz'),
    ('quotes','paid_amount_cents','bigint'),('quotes','paid_stripe_session_id','text'),('quotes','stripe_connect_destination','text'),
    ('quotes','customer_released_at','timestamptz'),('quotes','customer_released_by','text'),
    ('quotes','price_hold_until','timestamptz'),('quotes','deposit_pct','numeric'),
    ('quotes','subtotal_ex_gst','numeric'),('quotes','gst','numeric'),('quotes','total_inc_gst','numeric'),
    ('quotes','good','jsonb'),('quotes','better','jsonb'),('quotes','best','jsonb'),
    ('quotes','selected_tier','text'),('quotes','scope_of_works','text'),('quotes','scope_short','text'),
    ('quotes','assumptions','jsonb'),('quotes','risk_flags','jsonb'),('quotes','optional_upsells','jsonb'),
    ('quotes','estimated_timeframe','text'),('quotes','gst_note','text'),('quotes','display_mode','text'),
    ('quotes','needs_inspection','boolean'),('quotes','inspection_reason','text'),
    ('quotes','stripe_links','jsonb'),('quotes','report_doc','jsonb'),('quotes','report_style','jsonb'),
    ('quotes','applied_discount_pct','numeric'),
    ('intakes','id','uuid'),('intakes','tenant_id','uuid'),('intakes','trade','text'),('intakes','job_type','text'),
    ('quote_pricing_versions','id','uuid'),('quote_pricing_versions','tenant_id','uuid'),
    ('quote_pricing_versions','trade','text'),('quote_pricing_versions','snapshot','jsonb'),
    ('quote_pricing_versions','pricing_book_id','uuid'),('quote_pricing_versions','content_hash','text'),
    ('pricing_book','id','uuid'),('pricing_book','tenant_id','uuid'),('pricing_book','trade','text'),('pricing_book','gst_registered','boolean'),
    ('sms_outbox','id','uuid'),('sms_outbox','delivery_key','text'),('sms_outbox','tenant_id','uuid'),
    ('sms_outbox','payload','jsonb'),('sms_outbox','to_number','text'),('sms_outbox','status','text'),
    ('sms_outbox','payload_hash','text'),('sms_outbox','turn_id','uuid'),('sms_outbox','conversation_id','uuid'),
    ('sms_outbox','body','text'),('sms_outbox','audience','text'),('sms_outbox','sms_work_id','uuid'),('sms_outbox','sms_work_owner','uuid'),
    ('sms_outbox','provider_sid','text'),('sms_outbox','result','jsonb'),('sms_outbox','provider_status','text'),
    ('quote_credit_settlements','outbox_id','uuid'),('quote_credit_settlements','quote_id','uuid'),
    ('quote_credit_settlements','tenant_id','uuid'),('quote_credit_settlements','revision','text'),
    ('quote_credit_settlements','status','text'),('quote_credit_settlements','reason','text'),('quote_credit_settlements','updated_at','timestamptz'),
    ('paint_runs','id','uuid'),('paint_runs','tenant_id','uuid'),('paint_runs','job_name','text'),
    ('paint_runs','site_address','text'),('paint_runs','status','text'),('paint_runs','released_at','timestamptz'),('paint_runs','updated_at','timestamptz'),
    ('plan_extractions','id','uuid'),('plan_extractions','tenant_id','uuid'),('plan_extractions','paint_run_id','uuid'),('plan_extractions','trade','text'),
    ('plan_extractions','items','jsonb'),('plan_extractions','corrected_items','jsonb'),('plan_extractions','priced_bom','jsonb'),
    ('plan_extractions','paint_pricing_proof','jsonb'),('plan_extractions','sheets_used','jsonb'),
    ('plan_extractions','created_at','timestamptz'),('plan_extractions','updated_at','timestamptz'),('plan_extractions','priced_at','timestamptz'),
    ('paint_rates','trade','text'),('paint_rates','tenant_id','uuid'),('paint_rates','kind','text'),('paint_rates','code','text'),
    ('paint_rates','label','text'),('paint_rates','system','text'),('paint_rates','method','text'),('paint_rates','product','text'),
    ('paint_rates','coverage_m2_per_hr','numeric'),('paint_rates','spread_m2_per_l','numeric'),('paint_rates','price_per_l_ex_gst','numeric'),
    ('paint_rates','unit_hours','numeric'),('paint_rates','value','numeric'),('paint_rates','unit','text'),('paint_rates','is_default','boolean'),
    ('intakes','scope','jsonb'),('intakes','address','text'),('intakes','suburb','text'),('intakes','access','jsonb'),
    ('intakes','property','jsonb'),('intakes','risks','jsonb'),('intakes','inspection_required','boolean'),
    ('intakes','caller','jsonb'),('intakes','timing','jsonb'),('intakes','confidence','text'),('intakes','confidence_reason','text'),
    ('quotes','routing_decision','text'),('quotes','followed_up_at','timestamptz'),('quotes','followup_note','text'),
    ('followup_operations','id','uuid'),('followup_operations','tenant_id','uuid'),('followup_operations','request_id','uuid'),
    ('followup_operations','action','text'),('followup_operations','target_kind','text'),('followup_operations','target_id','uuid'),
    ('followup_operations','payload_hash','text'),('followup_operations','payload','jsonb'),('followup_operations','status','text'),
    ('followup_operations','history','text'),('followup_operations','provider_sid','text'),('followup_operations','outbox_id','uuid'),
    ('followup_operations','event_id','uuid'),('followup_operations','conversation_id','uuid'),
    ('followup_operations','created_at','timestamptz'),('followup_operations','accepted_at','timestamptz'),('followup_operations','updated_at','timestamptz'),
    ('sms_conversations','id','uuid'),('sms_conversations','tenant_id','uuid'),('sms_conversations','from_number','text'),('sms_conversations','to_number','text'),
    ('sms_conversations','status','text'),('sms_conversations','conversation_type','text'),('sms_conversations','last_message_at','timestamptz'),
    ('sms_conversations','updated_at','timestamptz'),('sms_conversations','followup_quote','jsonb'),
    ('sms_conversations','roofing_state','jsonb'),('sms_conversations','painting_state','jsonb'),
    ('sms_messages','conversation_id','uuid'),('sms_messages','direction','text'),('sms_messages','body','text'),
    ('sms_messages','twilio_message_sid','text'),('sms_messages','audience','text'),('sms_messages','to_number','text'),
    ('sms_messages','tenant_id','uuid'),('sms_messages','outbox_id','uuid'),('sms_messages','delivery_status','text'),('sms_messages','created_at','timestamptz'),
    ('quote_followup_events','id','uuid'),('quote_followup_events','tenant_id','uuid'),('quote_followup_events','quote_id','uuid'),
    ('quote_followup_events','actor_user_id','uuid'),('quote_followup_events','kind','text'),('quote_followup_events','outcome','text'),
    ('quote_followup_events','summary','text'),('quote_followup_events','note','text'),('quote_followup_events','created_at','timestamptz'),
    ('commercial_paint_correction_operations','tenant_id','uuid'),('commercial_paint_correction_operations','run_id','uuid'),
    ('commercial_paint_correction_operations','operation_id','uuid'),('commercial_paint_correction_operations','request_hash','text'),
    ('commercial_paint_correction_operations','expected_revision','text'),('commercial_paint_correction_operations','extraction_id','uuid'),
    ('commercial_paint_correction_operations','changes','jsonb'),('commercial_paint_correction_operations','outcome','jsonb'),
    ('commercial_paint_correction_operations','created_at','timestamptz'),
    ('paint_runs','public_token','text'),('paint_runs','customer_phone','text'),
    ('plan_extractions','released_at','timestamptz'),('plan_extractions','share_token','text'),
    ('roofing_measurements','id','uuid'),('roofing_measurements','tenant_id','uuid'),('roofing_measurements','customer_phone','text'),
    ('roofing_measurements','public_token','text'),('roofing_measurements','released_at','timestamptz'),('roofing_measurements','quote','jsonb'),
    ('painting_measurements','id','uuid'),('painting_measurements','tenant_id','uuid'),('painting_measurements','customer_phone','text'),
    ('painting_measurements','public_token','text'),('painting_measurements','released_at','timestamptz'),
    ('solar_estimates','id','uuid'),('solar_estimates','tenant_id','uuid'),('solar_estimates','customer_phone','text'),
    ('solar_estimates','public_token','text'),('solar_estimates','confirmed_at','timestamptz'),
    ('solar_estimates','guardrail_flags','jsonb'),('solar_estimates','intake_id','uuid'),
    ('aircon_recommendations','id','uuid'),('aircon_recommendations','tenant_id','uuid'),('aircon_recommendations','customer_phone','text'),
    ('aircon_recommendations','public_token','text'),('aircon_recommendations','released_at','timestamptz'),
    ('plan_upload_requests','tenant_id','uuid'),('plan_upload_requests','plan_extraction_id','uuid'),
    ('plan_upload_requests','customer_phone','text'),('plan_upload_requests','created_at','timestamptz')
  ), function_metadata(signature,language_name,volatility,configuration) as (values
    ('public.commercial_paint_pricing_source(uuid,uuid,uuid)','sql','s',array['search_path=pg_catalog, public']),
    ('public.persist_commercial_paint_pricing(uuid,uuid,uuid,jsonb,jsonb,jsonb)','plpgsql','v',array['search_path=pg_catalog, public']),
    ('public.save_commercial_paint_quote(uuid,uuid,uuid,jsonb,jsonb,jsonb,timestamptz,jsonb,jsonb)','plpgsql','v',array['search_path=pg_catalog, public']),
    ('public.followup_outbox_matches(public.followup_operations,public.sms_outbox)','sql','i',array['search_path=public, pg_temp']),
    ('public.followup_outbox_accepted(public.sms_outbox)','sql','i',array['search_path=public, pg_temp']),
    ('public.followup_operation_claim(uuid,uuid,text,text,uuid,text,jsonb)','plpgsql','v',array['search_path=public, pg_temp']),
    ('public.followup_operation_repair(uuid,uuid)','plpgsql','v',array['search_path=public, pg_temp']),
    ('public.followup_operation_try_repair(uuid,uuid)','plpgsql','v',array['search_path=public, pg_temp']),
    ('public.followup_outbox_evidence()','plpgsql','v',array['search_path=public, pg_temp']),
    ('public.followup_call_finish(uuid,uuid,text,text)','plpgsql','v',array['search_path=public, pg_temp']),
    ('public.followup_note_commit(uuid,uuid,uuid,text,jsonb)','plpgsql','v',array['search_path=public, pg_temp']),
    ('public.commercial_paint_edit_snapshot(uuid,uuid)','sql','s',array['search_path=pg_catalog, public']),
    ('public.commercial_paint_valid_correction(jsonb)','plpgsql','i',array['search_path=pg_catalog, public']),
    ('public.commercial_paint_correction_status(uuid,uuid,uuid)','plpgsql','s',array['search_path=pg_catalog, public']),
    ('public.apply_commercial_paint_correction(uuid,uuid,uuid,text,uuid,text,jsonb)','plpgsql','v',array['search_path=pg_catalog, public']),
    ('public.sms_release_quote_resource(uuid,text,uuid,text,jsonb,text,jsonb)','plpgsql','v',array['search_path=public, pg_temp']),
    ('public.guard_commercial_quote_extraction()','plpgsql','v',array['search_path=pg_catalog, public','row_security=off']),
    ('public.guard_commercial_quote_run()','plpgsql','v',array['search_path=pg_catalog, public']),
    ('public.sms_normalise_customer_phone(text)','sql','i',array['search_path=public, pg_temp'])
  ), definer_tables(function_name,table_name,privileges) as (values
    -- Row locks require UPDATE as well as SELECT. Quote writes also execute
    -- the207 invoker guard, which reads intake/version ownership.
    ('prepare_balance_quote','quotes',array['SELECT','INSERT','UPDATE']),
    ('prepare_balance_quote','intakes',array['SELECT','UPDATE']),
    ('prepare_balance_quote','quote_pricing_versions',array['SELECT']),
    ('prepare_final_quote','quotes',array['SELECT','INSERT','UPDATE']),
    ('prepare_final_quote','intakes',array['SELECT','UPDATE']),
    ('prepare_final_quote','quote_pricing_versions',array['SELECT']),
    ('approve_generic_quote_release','quotes',array['SELECT','UPDATE']),
    ('approve_generic_quote_release','sms_outbox',array['SELECT']),
    ('approve_generic_quote_release','intakes',array['SELECT']),
    ('approve_generic_quote_release','quote_pricing_versions',array['SELECT']),
    ('settle_final_quote_credit','sms_outbox',array['SELECT']),
    ('settle_final_quote_credit','quotes',array['SELECT','UPDATE']),
    ('settle_final_quote_credit','intakes',array['SELECT','UPDATE']),
    ('settle_final_quote_credit','quote_credit_settlements',array['SELECT','INSERT','UPDATE']),
    ('settle_final_quote_credit','quote_pricing_versions',array['SELECT']),
    ('sms_outbox_enqueue','sms_outbox',array['SELECT','INSERT']),
    ('reflect_generic_quote_delivery','quotes',array['SELECT','UPDATE']),
    ('reflect_generic_quote_delivery','intakes',array['SELECT']),
    ('reflect_generic_quote_delivery','quote_pricing_versions',array['SELECT']),
    ('capture_quote_pricing_version','pricing_book',array['SELECT','UPDATE']),
    ('capture_quote_pricing_version','quote_pricing_versions',array['SELECT','INSERT']),
    ('followup_operation_claim','followup_operations',array['SELECT','INSERT','UPDATE']),
    ('followup_operation_claim','quotes',array['SELECT','UPDATE']),
    ('followup_operation_claim','sms_conversations',array['SELECT','UPDATE']),
    ('followup_operation_repair','followup_operations',array['SELECT','UPDATE']),
    ('followup_operation_repair','quotes',array['SELECT','UPDATE']),
    ('followup_operation_repair','sms_conversations',array['SELECT','INSERT','UPDATE']),
    ('followup_operation_repair','sms_outbox',array['SELECT']),
    ('followup_operation_repair','sms_messages',array['SELECT','INSERT','UPDATE']),
    ('followup_operation_repair','quote_followup_events',array['SELECT','INSERT']),
    ('followup_outbox_evidence','followup_operations',array['SELECT','UPDATE']),
    ('followup_call_finish','followup_operations',array['SELECT','UPDATE']),
    ('followup_note_commit','followup_operations',array['SELECT','UPDATE']),
    ('followup_note_commit','quotes',array['SELECT','UPDATE']),
    ('followup_note_commit','intakes',array['SELECT']),
    ('followup_note_commit','quote_pricing_versions',array['SELECT']),
    ('followup_note_commit','quote_followup_events',array['INSERT']),
    -- The reviewed rich writer retains all six families. Its invoker pricing
    -- source and commercial row guards execute with the same effective role.
    ('sms_release_quote_resource','roofing_measurements',array['SELECT','UPDATE']),
    ('sms_release_quote_resource','painting_measurements',array['SELECT','UPDATE']),
    ('sms_release_quote_resource','solar_estimates',array['SELECT','UPDATE']),
    ('sms_release_quote_resource','plan_extractions',array['SELECT','UPDATE']),
    ('sms_release_quote_resource','aircon_recommendations',array['SELECT','UPDATE']),
    ('sms_release_quote_resource','paint_runs',array['SELECT','UPDATE']),
    ('sms_release_quote_resource','paint_rates',array['SELECT','UPDATE']),
    ('sms_release_quote_resource','pricing_book',array['SELECT','UPDATE']),
    ('sms_release_quote_resource','intakes',array['SELECT']),
    ('sms_release_quote_resource','plan_upload_requests',array['SELECT'])
  ), definer_calls(function_name,dependency) as (values
    ('approve_generic_quote_release','public.sms_outbox_enqueue(text,jsonb,text)'),
    ('reflect_final_quote_credit','public.settle_final_quote_credit(uuid,uuid)'),
    ('followup_operation_repair','public.followup_outbox_matches(public.followup_operations,public.sms_outbox)'),
    ('followup_operation_repair','public.followup_outbox_accepted(public.sms_outbox)'),
    ('followup_operation_try_repair','public.followup_operation_repair(uuid,uuid)'),
    ('followup_outbox_evidence','public.followup_outbox_matches(public.followup_operations,public.sms_outbox)'),
    ('followup_outbox_evidence','public.followup_outbox_accepted(public.sms_outbox)'),
    ('followup_outbox_evidence','public.followup_operation_try_repair(uuid,uuid)'),
    ('followup_call_finish','public.followup_operation_try_repair(uuid,uuid)'),
    ('followup_note_commit','public.followup_operation_claim(uuid,uuid,text,text,uuid,text,jsonb)'),
    ('sms_release_quote_resource','public.commercial_paint_pricing_source(uuid,uuid,uuid)'),
    ('sms_release_quote_resource','public.sms_normalise_customer_phone(text)'),
    ('sms_release_quote_resource','public.sms_outbox_enqueue(text,jsonb,text)')
  ), service_permissions(table_name,privilege_name) as (values
    ('paint_runs','SELECT'),('paint_runs','UPDATE'),('plan_extractions','SELECT'),('plan_extractions','UPDATE'),
    -- Verify the standard UPDATE privilege authorizing219 SHARE locks;
    -- SELECT alone does not authorize that lock mode.
    ('paint_rates','SELECT'),('paint_rates','UPDATE'),('pricing_book','SELECT'),('pricing_book','UPDATE'),
    ('quotes','SELECT'),('quotes','INSERT'),('quotes','UPDATE'),('intakes','SELECT'),('intakes','INSERT'),
    ('followup_operations','SELECT'),('followup_operations','UPDATE'),('quote_followup_events','SELECT'),
    ('commercial_paint_correction_operations','SELECT'),('commercial_paint_correction_operations','INSERT')
  ), correction_nullability(column_name,not_null) as (values
    ('tenant_id',true),('run_id',true),('operation_id',true),('request_hash',true),('expected_revision',true),
    ('extraction_id',false),('changes',true),('outcome',true),('created_at',true)
  ), correction_checks(expression) as (values
    ('request_hash~''^[a-f0-9]{64}$''::text'),('expected_revision~''^[a-f0-9]{64}$''::text')
  ), followup_defaults(column_name,expression) as (values
    ('id','gen_random_uuid()'),('status','''pending''::text'),('history','''pending''::text'),
    ('created_at','now()'),('updated_at','now()'),('provider_sid',null::text),('outbox_id',null::text),
    ('event_id',null::text),('conversation_id',null::text),('accepted_at',null::text)
  ), followup_nullability(column_name,not_null) as (values
    ('id',true),('tenant_id',true),('request_id',true),('action',true),('target_kind',true),('target_id',true),
    ('payload_hash',true),('payload',true),('status',true),('history',true),('created_at',true),('updated_at',true),
    ('provider_sid',false),('outbox_id',false),('event_id',false),('conversation_id',false),('accepted_at',false)
  ), followup_checks(expression) as (values
    ('action=ANYARRAY[''text''::text,''call''::text,''note''::text]'),
    ('target_kind=ANYARRAY[''quote''::text,''conversation''::text]'),
    ('status=ANYARRAY[''pending''::text,''unknown''::text,''accepted''::text,''failed''::text,''complete''::text]'),
    ('history=ANYARRAY[''pending''::text,''complete''::text,''not_applicable''::text]')
  ), roles as (
    select (select oid from pg_roles where rolname='service_role') service_role,
      (select oid from pg_roles where rolname='anon') anon_role,
      (select oid from pg_roles where rolname='authenticated') authenticated_role
  )
  select coalesce(
    not exists (
      select 1 from required_functions r cross join roles
      left join function_metadata m on m.signature=r.signature
      left join pg_proc p on p.oid=to_regprocedure(r.signature)
      left join pg_language l on l.oid=p.prolang
      where p.oid is null or r.body_sha256 is null or
        encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex') is distinct from r.body_sha256 or
        p.prokind<>'f' or p.prorettype is distinct from to_regtype(r.result_type) or p.proretset or
        l.lanname is distinct from coalesce(m.language_name,'plpgsql') or p.prosecdef is distinct from r.definer or
        p.proisstrict is distinct from (r.signature='public.sms_normalise_customer_phone(text)') or p.proleakproof or
        p.provolatile::text is distinct from coalesce(m.volatility,'v') or p.proparallel<>'u' or p.proargmodes is not null or
        p.proargnames is distinct from r.arg_names or p.pronargdefaults<>r.default_count or
        pg_get_expr(p.proargdefaults,0) is distinct from r.defaults or
        p.proconfig is distinct from coalesce(m.configuration,array['search_path=public']) or
        roles.service_role is null or roles.anon_role is null or roles.authenticated_role is null or
        has_schema_privilege(roles.service_role,'public','USAGE') is distinct from true or
        (r.definer and has_schema_privilege(p.proowner,'public','USAGE') is distinct from true) or
        has_function_privilege(roles.service_role,p.oid,'EXECUTE') is distinct from (r.execute_policy<>'owner_only') or
        has_function_privilege(roles.anon_role,p.oid,'EXECUTE') is distinct from (r.execute_policy='owner_public') or
        has_function_privilege(roles.authenticated_role,p.oid,'EXECUTE') is distinct from (r.execute_policy='owner_public') or
        exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
          where acl.privilege_type='EXECUTE' and acl.grantee<>p.proowner and
            (acl.is_grantable or not ((r.execute_policy='service_only' and acl.grantee=roles.service_role) or
              (r.execute_policy='owner_public' and acl.grantee=0))))
    ) and not exists (
      -- SECURITY DEFINER executes as its owner. Correct bytes and caller ACLs
      -- are insufficient when that owner loses its table or RLS authority.
      select 1 from required_functions r join pg_proc p on p.oid=to_regprocedure(r.signature)
      join definer_tables required on required.function_name=p.proname
      cross join lateral unnest(required.privileges) privilege(name)
      left join pg_roles owner_role on owner_role.oid=p.proowner
      left join pg_class c on c.oid=to_regclass('public.'||required.table_name)
      where r.definer and (owner_role.oid is null or c.oid is null or
        has_table_privilege(p.proowner,c.oid,privilege.name) is distinct from true or
        (c.relrowsecurity and not (owner_role.rolsuper or owner_role.rolbypassrls or
          (pg_has_role(p.proowner,c.relowner,'USAGE') and not c.relforcerowsecurity))))
    ) and not exists (
      select 1 from required_functions r join pg_proc p on p.oid=to_regprocedure(r.signature)
      join definer_calls required on required.function_name=p.proname
      left join pg_proc dependency on dependency.oid=to_regprocedure(required.dependency)
      where r.definer and (dependency.oid is null or
        has_function_privilege(p.proowner,dependency.oid,'EXECUTE') is distinct from true)
    ) and not exists (
      select 1 from service_permissions required cross join roles
      left join pg_class c on c.oid=to_regclass('public.'||required.table_name)
      where c.oid is null or has_table_privilege(roles.service_role,c.oid,required.privilege_name) is distinct from true
    ) and not exists (
      select 1 from (values ('followup_operations',array['request_id','tenant_id']),('followup_operations',array['id']),
        ('quote_followup_events',array['id']),
        ('commercial_paint_correction_operations',array['operation_id','run_id','tenant_id'])) required(table_name,column_names)
      where not exists (
        select 1 from pg_index i where i.indrelid=to_regclass('public.'||required.table_name)
          and i.indisunique and i.indisvalid and i.indisready and i.indislive and i.indimmediate
          and i.indnkeyatts=cardinality(required.column_names) and i.indnatts=cardinality(required.column_names)
          and i.indexprs is null and i.indpred is null and array(
            select a.attname::text from unnest(i.indkey) key(attnum) join pg_attribute a
              on a.attrelid=i.indrelid and a.attnum=key.attnum and not a.attisdropped order by a.attname)=required.column_names)
    ) and not exists (
      select 1 from (values ('followup_operations','followup_operation_provider_idx','provider_sid'),
        ('sms_messages','sms_messages_outbox_once','outbox_id')) required(table_name,index_name,column_name)
      where not exists (
        select 1 from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attname=required.column_name and not a.attisdropped
        where i.indexrelid=to_regclass('public.'||required.index_name) and i.indrelid=to_regclass('public.'||required.table_name)
          and i.indisunique and i.indisvalid and i.indisready and i.indislive and i.indimmediate
          and i.indnkeyatts=1 and i.indnatts=1 and i.indkey[0]=a.attnum and i.indexprs is null
          and regexp_replace(pg_get_expr(i.indpred,i.indrelid),'[[:space:]()]','','g')=required.column_name||'ISNOTNULL')
    ) and exists (
      select 1 from pg_class c cross join roles where c.oid=to_regclass('public.followup_operations') and c.relrowsecurity
        and not has_table_privilege(roles.anon_role,c.oid,'SELECT') and not has_table_privilege(roles.authenticated_role,c.oid,'SELECT')
        and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
          where acl.grantee<>c.relowner and (acl.grantee<>roles.service_role or acl.is_grantable))
    ) and not exists (
      select 1 from correction_nullability required
      left join pg_attribute a on a.attrelid=to_regclass('public.commercial_paint_correction_operations') and a.attname=required.column_name and not a.attisdropped
      where a.attnum is null or a.attnotnull is distinct from required.not_null
    ) and not exists (
      select 1 from correction_checks required where not exists (
        select 1 from pg_constraint c where c.conrelid=to_regclass('public.commercial_paint_correction_operations')
          and c.contype='c' and c.convalidated and not c.connoinherit
          and regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[[:space:]()]','','g')=required.expression)
    ) and exists (
      select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=to_regclass('public.commercial_paint_correction_operations') and a.attname='created_at' and not a.attisdropped
        and pg_get_expr(d.adbin,d.adrelid)='clock_timestamp()'
    ) and exists (
      select 1 from pg_class c cross join roles where c.oid=to_regclass('public.commercial_paint_correction_operations') and c.relrowsecurity
        -- These INVOKER RPCs need authority over their own receipt table.
        -- Ownership of an unrelated settlement table does not confer it.
        and exists(select 1 from pg_roles execution where execution.oid=roles.service_role and
          (execution.rolsuper or execution.rolbypassrls or
            (pg_has_role(roles.service_role,c.relowner,'USAGE') and not c.relforcerowsecurity)))
        and not has_table_privilege(roles.anon_role,c.oid,'SELECT') and not has_table_privilege(roles.authenticated_role,c.oid,'SELECT')
        and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
          where acl.grantee<>c.relowner and (acl.grantee<>roles.service_role or acl.is_grantable or acl.privilege_type not in ('SELECT','INSERT')))
    ) and not exists (
      select 1 from followup_defaults required
      left join pg_attribute a on a.attrelid=to_regclass('public.followup_operations') and a.attname=required.column_name and not a.attisdropped
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attnum is null or pg_get_expr(d.adbin,d.adrelid) is distinct from required.expression
    ) and not exists (
      select 1 from followup_nullability required
      left join pg_attribute a on a.attrelid=to_regclass('public.followup_operations') and a.attname=required.column_name and not a.attisdropped
      where a.attnum is null or a.attnotnull is distinct from required.not_null
    ) and not exists (
      select 1 from followup_checks required where not exists (
        select 1 from pg_constraint c where c.conrelid=to_regclass('public.followup_operations')
          and c.contype='c' and c.convalidated and not c.connoinherit
          and regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[[:space:]()]','','g')=required.expression)
    ) and exists (
      -- The enqueue ON CONFLICT target must resolve to an immediate, complete
      -- unique key. A named index alone or a partial index is insufficient.
      select 1 from pg_index i
      join pg_attribute a on a.attrelid=i.indrelid and a.attname='delivery_key' and not a.attisdropped
      where i.indrelid=to_regclass('public.sms_outbox') and i.indisunique and i.indisvalid
        and i.indisready and i.indislive and i.indimmediate and i.indnkeyatts=1 and i.indnatts=1
        and i.indkey[0]=a.attnum and i.indexprs is null and i.indpred is null
    ) and exists (
      select 1 from pg_index i
      where i.indrelid=to_regclass('public.quote_pricing_versions') and i.indisunique and i.indisvalid
        and i.indisready and i.indislive and i.indimmediate and i.indnkeyatts=4 and i.indnatts=4
        and i.indexprs is null and i.indpred is null and
        array(select a.attname::text from unnest(i.indkey) key(attnum)
          join pg_attribute a on a.attrelid=i.indrelid and a.attnum=key.attnum and not a.attisdropped order by a.attname)=
          array['content_hash','pricing_book_id','tenant_id','trade']
    ) and exists (
      select 1 from pg_index i
      join pg_attribute a on a.attrelid=i.indrelid and a.attname='outbox_id' and not a.attisdropped
      where i.indrelid=to_regclass('public.quote_credit_settlements') and i.indisunique and i.indisvalid
        and i.indisready and i.indislive and i.indimmediate and i.indnkeyatts=1 and i.indnatts=1
        and i.indkey[0]=a.attnum and i.indexprs is null and i.indpred is null
    ) and exists (
      -- The owner readback consumes this table directly. Retain its217 RLS and
      -- service-only read contract without exposing accounting rows to clients.
      select 1 from pg_class c cross join roles
      where c.oid=to_regclass('public.quote_credit_settlements') and c.relrowsecurity
        and ((select r.rolbypassrls or r.rolsuper from pg_roles r where r.oid=roles.service_role)
          or (c.relowner=roles.service_role and not c.relforcerowsecurity))
        and has_table_privilege(roles.service_role,c.oid,'SELECT')
        and not has_table_privilege(roles.anon_role,c.oid,'SELECT')
        and not has_table_privilege(roles.authenticated_role,c.oid,'SELECT')
    ) and not exists (
      select 1 from required_columns r
      left join pg_class c on c.oid=to_regclass('public.'||r.table_name)
      left join pg_attribute a on a.attrelid=c.oid and a.attname=r.column_name and a.attnum>0 and not a.attisdropped
      where c.oid is null or c.relkind not in ('r','p') or a.attnum is null or a.atttypid is distinct from to_regtype(r.type_name)
    ) and exists (
      -- The complete lifetime constraint from 214, including settled children.
      -- A similarly named non-unique, invalid, or unpaid-only index is not enough.
      select 1 from pg_index i
      join pg_attribute a on a.attrelid=i.indrelid and a.attname='parent_quote_id' and not a.attisdropped
      where i.indexrelid=to_regclass('public.quotes_one_final_per_parent') and i.indrelid=to_regclass('public.quotes')
        and i.indisunique and i.indisvalid and i.indisready and i.indislive and i.indimmediate
        and i.indnkeyatts=1 and i.indnatts=1 and i.indkey[0]=a.attnum and i.indexprs is null
        and regexp_replace(pg_get_expr(i.indpred,i.indrelid),'[[:space:]()]','','g')=
          'quote_kind=''final''::textANDparent_quote_idISNOTNULL'
    ) and not exists (
      select 1 from (values
        ('sms_outbox','a_final_quote_credit','public.reflect_final_quote_credit()',21,'status'),
        ('sms_outbox','followup_outbox_evidence','public.followup_outbox_evidence()',21,null),
        ('sms_outbox','generic_quote_delivery','public.reflect_generic_quote_delivery()',21,'status'),
        ('quote_pricing_versions','quote_pricing_version_immutable','public.guard_quote_pricing_version()',19,null),
        ('quotes','quote_pricing_version_owner','public.guard_quote_pricing_version_owner()',23,null),
        ('plan_extractions','sms_commercial_extraction_guard','public.guard_commercial_quote_extraction()',31,null),
        ('paint_runs','sms_commercial_run_guard','public.guard_commercial_quote_run()',27,null)
      ) r(table_name,trigger_name,function_name,event_type,update_column)
      left join pg_trigger t on t.tgrelid=to_regclass('public.'||r.table_name) and t.tgname=r.trigger_name
      where t.oid is null or t.tgenabled not in ('O','A') or t.tgisinternal or
        t.tgfoid is distinct from to_regprocedure(r.function_name) or t.tgtype<>r.event_type or t.tgqual is not null or
        t.tgattr::text is distinct from coalesce((select a.attnum::text from pg_attribute a
          where a.attrelid=t.tgrelid and a.attname=r.update_column and not a.attisdropped),'')
    ),
    false);
$readiness$;

revoke all on function public.sms_quote_chain_ready() from public,anon,authenticated;
grant execute on function public.sms_quote_chain_ready() to service_role;
notify pgrst,'reload schema';
commit;

// Offline, scripted provider responses. These fixtures replace transport/model
// boundaries, never the compiled routes, specialists, pricing or persistence.
/* eslint-disable @typescript-eslint/no-require-imports -- Shared with the candidate's CommonJS child loader. */
const assert = require('node:assert/strict')
const TENANT='11111111-1111-4111-8111-111111111111'
const BOOK='22222222-2222-4222-8222-222222222222'
const CUSTOMER='+61411111111', OWNER='+61422222222', TO='+61488888888'
const ADDRESS='12 Example Road, Sydney NSW 2000'
const roofCard={
  reroof_rate_per_m2:{colorbond_corrugated:91,colorbond_trimdek:96,colorbond_spandek:98,colorbond_kliplok:111,concrete_tile:89,terracotta_tile:106,cement_sheet:141},
  multi_storey_loading_pct:0.2,asbestos_loading_pct:0.35,complexity_loading_pct:0.15,upgrade_material:'colorbond_trimdek',gst_registered:true,
  call_out_minimum_ex_gst:500,gutter_rate_per_lm:40,downpipe_rate_per_each:220,fascia_rate_per_lm:50,soffit_rate_per_lm:60,
  ridge_hip_repoint_rate_per_lm:15,valley_flashing_rate_per_lm:45,box_gutter_rate_per_lm:70,price_edge_works:true,
  solar_detach_reinstate_base_ex_gst:1200,solar_detach_reinstate_per_array_ex_gst:500,
}
const paintCard={rate_per_unit:{walls:31,ceilings:22,trim:13,exterior:49},coats_multiplier:{1:0.7,2:1,3:1.35},condition_multiplier:{sound:1,minor:1.15,bare:1.4},colour_change_extra:0.1,good_refresh_fraction:0.72,premium_uplift_pct:0.28,double_storey_loading_pct:0.5,gst_registered:true,call_out_minimum_ex_gst:450,pricing_model:'sqm',hourly_rate:87,production_rate_per_unit:{walls:3,ceilings:4,trim:7,exterior:2}}
const solarCard={install_rate_per_kw:{standard_panels:1110,premium_panels:1510},multi_storey_loading_pct:0.1,complex_roof_loading_pct:0.1,call_out_minimum_ex_gst:500,stc_price_aud:20,gst_registered:true,deposit_pct:10}
const solarBody={imageryQuality:'HIGH',imageryDate:{year:2024,month:3,day:12},solarPotential:{maxArrayPanelsCount:30,panelCapacityWatts:400,panelHeightMeters:1.879,panelWidthMeters:1.045,maxSunshineHoursPerYear:2400,maxArrayAreaMeters2:58.5,panelLifetimeYears:20,wholeRoofStats:{areaMeters2:130,sunshineQuantiles:[900,1100,1300,1450,1500,1550,1600,1650,1700,1750,1800]},roofSegmentStats:[{pitchDegrees:20,azimuthDegrees:0,stats:{areaMeters2:70,sunshineQuantiles:[1200,1300,1400,1500,1550,1600,1650,1700,1750,1800,1850]}},{pitchDegrees:20,azimuthDegrees:180,stats:{areaMeters2:50,sunshineQuantiles:[800,900,1000,1100,1150,1200,1250,1300,1350,1400,1450]}}],solarPanelConfigs:[{panelsCount:10,yearlyEnergyDcKwh:6000},{panelsCount:12,yearlyEnergyDcKwh:7200},{panelsCount:15,yearlyEnergyDcKwh:9000}]}}
function fixture(trade) {
  const jobType=trade==='plumbing'?'tap_repair':'power_points'
  const generic=`Hi, I'm Sam in Sydney. Please ${trade==='plumbing'?'repair one dripping laundry tap by replacing its washer':'replace two existing indoor double power points in my garage'}. The address is ${ADDRESS}. Single storey, standard ceiling, easy access, no damage or hazards. Please prepare the draft for review.`
  const turns=trade==='solar'?[`I need a solar quote at ${ADDRESS}.`,'Yes, that address is correct.','Single phase.','Standard panels.']
    :trade==='roofing'?[`I'm Sam. Please quote a complete Colorbond corrugated re-roof at ${ADDRESS}. The house was built in 2010, standard pitch, residential.`,`Let's continue by text. The property is ${ADDRESS}; complete Colorbond corrugated re-roof, built in 2010, standard pitch, residential.`,`Yes, that address is correct. Please measure and prepare the draft.`]
      :trade==='painting'?[`I'm Sam. Please quote repainting interior walls at ${ADDRESS}. Two coats, sound condition, standard ceiling height, one storey, no colour change, 180 square metres floor area.`,`Let's continue by text. The property is ${ADDRESS}; interior walls, two coats, sound condition, standard ceiling height, one storey, no colour change, 180 square metres floor area.`,`Yes, that address is correct. Please prepare the painting draft.`]:[generic,'Yes, that summary and the address are correct. Please prepare the draft.']
  const slots={first_name:'Sam',suburb:'Sydney',address:ADDRESS,job_type:jobType,count:trade==='plumbing'?1:2,room:trade==='plumbing'?'laundry':'garage',replace_or_new:'replace',ceiling_type:'flat_plaster'}
  const structure={job_type:jobType,address:ADDRESS,suburb:'Sydney',caller:{name:'Sam',phone:CUSTOMER},scope:{description:generic,item_count:trade==='plumbing'?1:2,is_new_install:false,existing_wiring:true,indoor_outdoor:'indoor',specs:{},requested_specs_json:'{}'},access:{ceiling_type:'flat',wall_type:'plaster'},property:{levels:1},risks:[],inspection_required:false,timing:{urgency:'flexible'},confidence:'HIGH',confidence_reason:'Explicit facts from the fixture customer.'}
  return {trade,jobType,turns,slots,structure,seed:{
    tenants:[{id:TENANT,trade,trades:[trade],status:'active',business_name:'Offline Journey Tradie',owner_mobile:OWNER,owner_first_name:'Taylor',twilio_sms_number:TO,twilio_phone_number:TO,owner_email:'owner@example.invalid',gst_registered:true}],
    pricing_book:[{id:BOOK,tenant_id:TENANT,trade,hourly_rate:120,apprentice_rate:60,call_out_minimum:120,default_markup_pct:0,min_labour_hours:1,gst_registered:true,overlays:{roofing_rate_card:roofCard,painting_rate_card:paintCard,solar_rate_card:solarCard}}],
  }}
}
function createModelProvider(config,record,currentInbound=()=> '') {
  let turn=0
  const objectResult=async options=>{
    const keys=Object.keys(options.schema?.shape??{})
    let value,kind
    if(keys.includes('tool')&&keys.includes('slots')) {
      kind='specialist-dialog'
      // The real specialists first offer a form. The customer chooses SMS,
      // then confirms the actual address read-back on the following turn.
      const confirmed=turn>=2
      value={tool:confirmed?(config.trade==='roofing'?'measure_and_price_roof':'price_painting'):'verify_address',reply_to_send:'Please confirm the installation address.',booking_consent:'unclear',declined_trade:null,structure_choices:null,
        slots:config.trade==='roofing'?{address:ADDRESS,postcode:'2000',state:'NSW',address_confirmed:confirmed,material:'colorbond_corrugated',pitch:'standard',intent:'full_reroof',year_built:2010,commercial:false}
          :{address:ADDRESS,postcode:'2000',state:'NSW',address_confirmed:confirmed,scopes:['walls'],coats:2,condition:'sound',ceiling_height:'standard',storeys:1,colour_change:false,manual_floor_area_m2:180}}
    } else if(keys.includes('ready_for_intake')) {
      kind='general-dialog';value={action:turn>0?'finish':'ask',job_type_guess:config.jobType,ready_for_intake:turn>0,reply_to_send:turn>0?'Thanks, your details are ready for the tradie to review.':`Please confirm: ${config.trade==='plumbing'?'repair the dripping laundry tap':'replace two existing garage power points'} at ${ADDRESS}. Is that correct?`,assumptions_made:[],request_photo_link:false,offer_product_choice:false}
      if(currentInbound()==='Correction: my first name is Alex, not Sam.') {
        assert.ok(JSON.stringify(options.messages??options.prompt).includes('Alex'),'Actual model input must contain the queued correction')
        value={...value,action:'ask',job_type_guess:['electrical','plumbing'].includes(config.trade)?config.jobType:'unknown',ready_for_intake:false,
          reply_to_send:'Thanks Alex, I have corrected your name. The draft still needs tradie review before a quote can be shared.'}
      }
    } else if(keys.length===1&&keys[0]==='reply') {
      // Generated specialist services keep post-draft questions in the real
      // scoped fallback. Supply its model boundary, not a TurnDecision/tool.
      assert.ok(['roofing','painting','solar'].includes(config.trade))
      assert.equal(currentInbound(),'Correction: my first name is Alex, not Sam.')
      assert.ok(options.system.startsWith(`You assist an Australian ${config.trade} business by SMS.`))
      assert.match(options.prompt,/Customer: Correction: my first name is Alex, not Sam\./)
      kind='scoped-fallback';value={reply:'Thanks Alex, I have corrected your name. The draft still needs tradie review before a quote can be shared.'}
    } else if(keys.includes('scope')&&keys.includes('caller')) {kind='structure';value=config.structure}
    else throw new Error(`Unregistered model object schema ${keys.join(',')}`)
    const parsed=options.schema.parse(value)
    await record({kind:'model',operation:kind,turn,inbound:currentInbound()})
    return {object:parsed,usage:{inputTokens:1,outputTokens:1},providerMetadata:{}}
  }
  const textResult=async options=>{
    if(options.tools?.applyMarkup) {
      // Execute the real money tool. The model fixture is grounded in the
      // tenant's seeded hourly rate; the real estimator still validates it.
      const priced=await options.tools.applyMarkup.execute({basePrice:120,markupPct:0},{toolCallId:'offline-rate',messages:[],abortSignal:new AbortController().signal})
      assert.equal(priced.final,120)
      await record({kind:'model',operation:'estimate',tool:'applyMarkup',turn})
      const tier=hours=>({line_items:[{description:'Tradesperson labour',quantity:hours,unit:'hr',unit_price_ex_gst:priced.final,total_ex_gst:hours*priced.final,source:'labour'}],subtotal_ex_gst:hours*priced.final})
      return {text:JSON.stringify({needs_inspection:false,scope_of_works:config.structure.scope.description,assumptions:[],risk_flags:[],good:tier(1.5),better:tier(2),best:tier(2.5)}),providerMetadata:{},usage:{inputTokens:1,outputTokens:1},steps:[]}
    }
    const prompt=JSON.stringify(options.messages??options.prompt??'')
    if(prompt.includes('updates')&&prompt.includes('CUSTOMER MESSAGE')) {
      const correction=currentInbound()==='Correction: my first name is Alex, not Sam.'
      if(correction)assert.ok(prompt.includes('Alex'),'Actual extraction input must contain the queued correction')
      await record({kind:'model',operation:'slot-extraction',turn,inbound:currentInbound()})
      return {text:JSON.stringify({updates:correction?{first_name:'Alex'}:{...config.slots,verified:turn>0},reasoning:'Explicit customer facts.'}),providerMetadata:{},usage:{inputTokens:1,outputTokens:1}}
    }
    throw new Error(`Unregistered model text request: ${prompt.slice(0,160)}`)
  }
  return {setTurn:index=>{turn=index},generateObject:objectResult,generateText:textResult}
}
async function providerResponse(url,request) {
  if(url.hostname==='addressvalidation.googleapis.com'&&url.pathname==='/v1:validateAddress') {
    const body=await request.json()
    assert.equal(body.address.regionCode,'AU')
    assert.match(body.address.addressLines.join(' '),/12\s+example\s+(road|rd)/i,'Address verification must use the customer fixture address')
    return Response.json({responseId:'offline-validation',result:{verdict:{validationGranularity:'PREMISE',geocodeGranularity:'PREMISE',addressComplete:true},address:{formattedAddress:ADDRESS,missingComponentTypes:[],unconfirmedComponentTypes:[],unresolvedTokens:[]},geocode:{location:{latitude:-33.8688,longitude:151.2093}}}})
  }
  if(url.hostname==='maps.googleapis.com'&&url.pathname.includes('/geocode/')) {
    assert.match(url.searchParams.get('address')??'',/12\s+example\s+(road|rd)/i,'Geocoding must use the customer fixture address')
    return Response.json({status:'OK',results:[{formatted_address:ADDRESS,geometry:{location:{lat:-33.8688,lng:151.2093}},address_components:[{long_name:'New South Wales',short_name:'NSW',types:['administrative_area_level_1']},{long_name:'2000',short_name:'2000',types:['postal_code']},{long_name:'Sydney',short_name:'Sydney',types:['locality']}]}]})
  }
  if(url.hostname==='solar.googleapis.com'&&url.pathname.includes('buildingInsights:findClosest')) {
    assert.equal(Number(url.searchParams.get('location.latitude')),-33.8688)
    assert.equal(Number(url.searchParams.get('location.longitude')),151.2093)
    return Response.json(solarBody)
  }
  return null
}
module.exports={fixture,createModelProvider,providerResponse,TENANT,BOOK,CUSTOMER,OWNER,TO,ADDRESS}

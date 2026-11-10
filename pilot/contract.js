(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.SFPilotContract=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
function assert(condition,message){if(!condition)throw new TypeError(message||'invalid pilot event');}
const defs = {
 attempt_started: {origin:'natural|assigned',phase:'baseline|product'},
 first_result_confirmed: {availability:'enough|missing',inventory_checked:'true',portions_checked:'true',list_checked:'true',assisted:'bool'},
 time_segment: {category:'setup|decision|maintenance|research|extra_trip',duration_sec:'uint',method:'timer|estimate',assisted:'bool'},
 operation_result: {operation_id:'id',kind:'add|edit|buy|consume_batch|undo_batch',status:'committed|failed|unknown',error_code:'none|conflict|network|validation|denied|server',revision:'nullable_id'},
 stock_readback: {operation_id:'id',revision:'id',status:'matched|mismatch'},
 cooking_reported: {outcome:'cooked|abandoned|unknown',unexpected_purchase:'yes|no|unknown',forced_substitution:'yes|no|unknown',assisted:'bool'},
 inventory_audit: {check_id:'id',direction:'app_to_shelf|shelf_to_app',presence_match:'bool',quantity_match:'bool',unit_match:'bool',date_match:'bool',measurable:'bool',false_sufficient:'bool'},
 day_closed: {had_home_dinner:'yes|no|unknown',used_app:'yes|no|unknown',time_complete:'bool',reason:'none|no_need|burden|distrust|error|other'},
 price_response: {offer:'A|B|none|undecided',price_kzt:'uint',value_episode_confirmed:'bool',positive_time_balance:'bool'}
};
const common={schema_version:'1.2',event_id:'id',pilot_id:'id',household_code:'id',actor_code:'A|B|system',attempt_id:'nullable_id',day_index:'day',build_sha:'sha',seq:'uint',source:'client|server|manual',event:'id',data:'object'};
function field(v,t){
 if(t==='bool')return typeof v==='boolean';
 if(t==='true')return v===true;
 if(t==='uint')return Number.isSafeInteger(v)&&v>=0;
 if(t==='day')return Number.isInteger(v)&&v>=1&&v<=14;
 if(t==='sha')return typeof v==='string'&&(/^[a-f0-9]{40}$/.test(v)||v==='SYNTHETIC');
 if(t==='nullable_id')return v===null||field(v,'id');
 if(t==='id')return typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
 if(t==='object')return !!v&&typeof v==='object'&&!Array.isArray(v);
 return typeof v==='string'&&t.split('|').includes(v);
}
function exact(o,d){
 assert(field(o,'object'));assert(JSON.stringify(Object.keys(o).sort())===JSON.stringify(Object.keys(d).sort()),'unexpected fields');
 for(const [k,t] of Object.entries(d))assert(field(o[k],t),k);
}
function validate(e){
 exact(e,common);assert(Object.hasOwn(defs,e.event));exact(e.data,defs[e.event]);
 if(!['inventory_audit','day_closed','price_response','time_segment'].includes(e.event))assert(e.attempt_id!==null);
 if(e.event==='time_segment'&&['decision','setup'].includes(e.data.category))assert(e.attempt_id!==null);
 if(e.event==='time_segment')assert(e.data.duration_sec<=86400,'interval exceeds one day');
 if(['inventory_audit','day_closed','price_response'].includes(e.event))assert(e.source==='manual'&&e.attempt_id===null);
 if(e.event==='operation_result'){
  if(e.data.status==='committed'){assert(e.source==='server');assert(e.data.revision!==null);assert(e.data.error_code==='none');}
 }
 if(e.event==='stock_readback')assert(e.source==='server');
 if(e.event==='price_response'){
  assert(e.day_index===14);assert(e.source==='manual');
  assert(e.data.price_kzt==={A:1990,B:490,none:0,undecided:0}[e.data.offer]);
 }
 return e;
}
return Object.freeze({validate,field});
});

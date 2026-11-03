'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validate,unique,completed,summarize,createRecorder}=require('../pilot/analytics.cjs');
let seq=0;
const family='SYN-H1';
function event(name,data,{h=family,day=4,a='A4',source='client'}={}){
 const n=++seq;return {schema_version:'1.2',event_id:'E'+n,pilot_id:'SYN',household_code:h,actor_code:'A',attempt_id:a,day_index:day,build_sha:'SYNTHETIC',seq:n,source,event:name,data};
}
function makeFamily(h){
 const rows=[];const put=(name,data,day,a=null,source='client')=>rows.push(event(name,data,{h,day,a,source}));
 for(const day of [1,2]){
  put('attempt_started',{origin:'natural',phase:'baseline'},day,'B'+day);
  put('time_segment',{category:'decision',duration_sec:1080,method:'timer',assisted:false},day,'B'+day);
  put('cooking_reported',{outcome:'cooked',unexpected_purchase:'no',forced_substitution:'no',assisted:false},day,'B'+day,'manual');
 }
 for(const day of [4,6,8,10]){
  const a='A'+day,op='OP'+day;
  put('attempt_started',{origin:'natural',phase:'product'},day,a);
  if(day===4)put('time_segment',{category:'setup',duration_sec:600,method:'timer',assisted:false},day,a);
  put('time_segment',{category:'decision',duration_sec:360,method:'timer',assisted:false},day,a);
  put('first_result_confirmed',{availability:'enough',inventory_checked:true,portions_checked:true,list_checked:true,assisted:false},day,a);
  put('operation_result',{operation_id:op,kind:'consume_batch',status:'committed',error_code:'none',revision:'R'+day},day,a,'server');
  put('stock_readback',{operation_id:op,revision:'R'+day,status:'matched'},day,a,'server');
  put('cooking_reported',{outcome:'cooked',unexpected_purchase:'no',forced_substitution:'no',assisted:false},day,a,'manual');
 }
 for(let day=1;day<=13;day++){
  if(day>=4)put('time_segment',{category:'maintenance',duration_sec:60,method:'estimate',assisted:false},day);
  put('day_closed',{had_home_dinner:'yes',used_app:day>=4?'yes':'no',time_complete:true,reason:'none'},day,null,'manual');
 }
 for(const day of [7,13])for(let i=0;i<5;i++)put('inventory_audit',{check_id:'C'+day+'-'+i,direction:i<3?'app_to_shelf':'shelf_to_app',presence_match:true,quantity_match:true,unit_match:true,date_match:true,measurable:true,false_sufficient:false},day,null,'manual');
 put('price_response',{offer:'A',price_kzt:1990,value_episode_confirmed:true,positive_time_balance:true},14,null,'manual');
 return rows;
}
const households=[1,2,3,4,5].map(i=>'SYN-H'+i);
const fixture=()=>households.flatMap(makeFamily);
const options={pilotId:'SYN',households,serverEvidenceVerified:true,timeEvidenceVerified:true};
const result=rows=>summarize(rows,options).households[0];
test('all seven metrics match hand-calculated household, including setup and maintenance',()=>{
 const r=result(fixture());assert.equal(r.m1.minutes,16);assert.equal(r.m2.successes,4);assert.equal(r.m3.per_day,1);assert.equal(r.m4.matches,10);assert.equal(r.m5.verified_cycles,4);assert.equal(r.m5.repeat_days,2);
 assert.deepEqual(r.m6.savings,{total:28,weekly:19.6});assert(r.m7.signal);
});
test('five households remain denominator with no events for one',()=>{const r=summarize(fixture().filter(e=>e.household_code!=='SYN-H5'),options);assert.equal(r.households.length,5);assert.equal(r.metrics.M2.total,5);assert.equal(r.households[4].attempts,0);assert.equal(r.metrics.M6.unknown,1);});
test('default evidence flags do not certify time or server authenticity',()=>{const r=summarize(fixture(),{pilotId:'SYN',households});assert.equal(r.metrics.M5.unknown,5);assert.equal(r.metrics.M6.unknown,5);assert.equal(r.pilot_admission,'NOT_EVALUATED');assert.equal(r.payment_permission,false);});
test('duplicate events do not inflate outcomes',()=>{const r=fixture();assert.deepEqual(summarize([...r,...r],options),summarize(r,options));});
test('key order has no effect on idempotency',()=>{const e=fixture()[0];assert.equal(unique([e,Object.fromEntries(Object.entries(e).reverse())]).length,1);});
test('event id collision rejected',()=>{const e=fixture()[0];assert.throws(()=>unique([e,{...e,day_index:3}]));});
test('forbidden text, weight and nested fields rejected',()=>{const e=fixture()[0];for(const v of [{...e,message:'x'},{...e,weight:70},{...e,data:{...e.data,recipe:'x'}}])assert.throws(()=>validate(v));});
test('missing diary day invalidates time, not converted to zero',()=>{const r=result(fixture().filter(e=>!(e.household_code===family&&e.event==='day_closed'&&e.day_index===9)));assert.equal(r.m3.per_day,null);assert.equal(r.m6.savings,null);assert.equal(r.observed_days,9);});
test('incomplete time declaration invalidates savings',()=>{const rows=fixture();rows.find(e=>e.household_code===family&&e.event==='day_closed'&&e.day_index===9).data.time_complete=false;assert.equal(result(rows).m6.savings,null);});
test('one baseline cannot yield savings',()=>{const r=result(fixture().filter(e=>!(e.household_code===family&&e.attempt_id==='B2')));assert.equal(r.m6.B,null);assert.equal(r.m6.savings,null);});
test('unknown outcome stays in attempts and is not success',()=>{const rows=fixture();rows.find(e=>e.household_code===family&&e.attempt_id==='A4'&&e.event==='cooking_reported').data.unexpected_purchase='unknown';const r=result(rows);assert.equal(r.m2.attempts,4);assert.equal(r.m2.successes,3);assert.equal(r.m2.unknown,1);});
test('forced substitution fails benefit even when inventory cycle completes',()=>{const rows=fixture();rows.find(e=>e.household_code===family&&e.attempt_id==='A4'&&e.event==='cooking_reported').data.forced_substitution='yes';assert.equal(result(rows).m2.successes,3);});
test('missing readback prevents full completion but preserves cooking report',()=>{const r=result(fixture().filter(e=>!(e.household_code===family&&e.event==='stock_readback'&&e.day_index===8)));assert.equal(r.m2.successes,4);assert.equal(r.m5.verified_cycles,3);assert.equal(r.m5.pass,false);});
test('undo invalidates cycle',()=>{const rows=fixture();rows.push(event('operation_result',{operation_id:'UNDO',kind:'undo_batch',status:'committed',error_code:'none',revision:'R-undo'},{day:8,a:'A8',source:'server'}));assert.equal(result(rows).m5.verified_cycles,3);});
test('revision mismatch is not readback proof',()=>{const rows=fixture();rows.find(e=>e.household_code===family&&e.event==='stock_readback'&&e.day_index===8).data.revision='other';assert.equal(result(rows).m5.pass,false);});
test('single-item consume cannot masquerade as a whole dinner',()=>{const e=fixture().find(e=>e.event==='operation_result');e.data.kind='use';assert.throws(()=>validate(e));});
test('assisted repeat is not independent usage',()=>{const rows=fixture();rows.find(e=>e.household_code===family&&e.event==='first_result_confirmed'&&e.day_index===8).data.assisted=true;assert.equal(result(rows).m5.pass,false);});
test('both repeat dinners assigned do not prove natural return',()=>{const rows=fixture();for(const e of rows)if(e.household_code===family&&e.event==='attempt_started'&&e.day_index>=8)e.data.origin='assigned';assert.equal(result(rows).m5.pass,false);});
test('audit sampling plan must have three forward and two reverse checks',()=>{const rows=fixture();rows.find(e=>e.household_code===family&&e.event==='inventory_audit'&&e.data.direction==='shelf_to_app').data.direction='app_to_shelf';assert.equal(result(rows).m4.pass,null);});
test('false sufficient triggers reliability alert regardless of percentage',()=>{const rows=fixture();rows.find(e=>e.household_code===family&&e.event==='inventory_audit').data.false_sufficient=true;const r=summarize(rows,options);assert(r.reliability_alert);assert.equal(r.households[0].m4.pass,false);});
test('negative balance prevents payment signal despite positive response',()=>{const rows=fixture();for(const e of rows)if(e.household_code===family&&e.event==='time_segment'&&e.data.category==='maintenance')e.data.duration_sec=600;assert(result(rows).m6.savings.total<0);assert.equal(result(rows).m7.signal,false);});
test('foreign household and pilot rejected',()=>{for(const key of ['household_code','pilot_id']){const rows=fixture();rows[0][key]='FOREIGN';assert.throws(()=>summarize(rows,options));}});
test('ambiguous seq, duplicate closure and orphan attempts fail closed',()=>{let rows=fixture();rows[1].seq=rows[0].seq;assert.throws(()=>summarize(rows,options));rows=fixture();const d=rows.find(e=>e.event==='day_closed');rows.push({...d,event_id:'NEW'});assert.throws(()=>summarize(rows,options));rows=fixture().filter(e=>!(e.event==='attempt_started'&&e.attempt_id==='A4'&&e.household_code===family));assert.throws(()=>summarize(rows,options));});
test('recorder is disabled unless all three conditions hold',()=>{const e=fixture()[0];for(const config of [{},{enabled:true},{enabled:true,consent:true}]){const r=createRecorder(config);assert.equal(r.record(e),false);assert.deepEqual(r.export(),[]);}});
test('opt-in buffer rejects server events, isolates scope, deduplicates and revokes',()=>{const rows=fixture(),e=rows[0];const r=createRecorder({enabled:true,consent:true,pilotApproved:true,pilotId:'SYN',householdCode:family});r.record(e);r.record(e);assert.equal(r.export().length,1);assert.throws(()=>r.record({...e,event_id:'NEW',source:'server'}));assert.throws(()=>r.record({...e,event_id:'NEW',household_code:'OTHER'}));const copy=r.export();copy[0].data.origin='assigned';assert.equal(r.export()[0].data.origin,'natural');r.revoke();assert.deepEqual(r.export(),[]);assert.equal(r.record(e),false);});
test('buffer cap does not silently discard events',()=>{const r=createRecorder({enabled:true,consent:true,pilotApproved:true,pilotId:'SYN',householdCode:family,maxEvents:1});const e=fixture()[0];r.record(e);assert.throws(()=>r.record({...e,event_id:'NEW'}));assert.equal(r.export().length,1);});
test('later missing diary does not erase measured first result',()=>{const r=result(fixture().filter(e=>!(e.household_code===family&&e.event==='day_closed'&&e.day_index===12)));assert.equal(r.m1.minutes,16);assert.equal(r.m6.savings,null);});
test('same operation cannot complete two different dinners',()=>{const rows=fixture();for(const e of rows)if(e.household_code===family&&e.day_index===8&&['operation_result','stock_readback'].includes(e.event))e.data.operation_id='OP4';assert.throws(()=>summarize(rows,options));});
test('first attempt without useful result fails M1',()=>{const r=result(fixture().filter(e=>!(e.household_code===family&&e.day_index===4&&e.event==='first_result_confirmed')));assert.equal(r.m1.pass,false);});
